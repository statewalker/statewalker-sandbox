import type { AgentConfig, FlueHarness, FlueSession, ModelConfig, SessionEnv } from "@flue/runtime";
import {
  bashFactoryToSessionEnv,
  createFlueContext,
  type FlueContextInternal,
  resolveModel,
} from "@flue/runtime/internal";
import type { FilesApi } from "@statewalker/webrun-files";
import { Bash } from "just-bash";
import { newAgentCommand } from "./agent-command.js";
import { type BuildBashTool, buildBash } from "./build-bash.js";
import { buildFilesViews, type FilesViews } from "./build-files-views.js";
import { configureGemini } from "./configure-gemini.js";
import { FilesApiAdapter } from "./files-api-adapter.js";
import { FilesApiSecretStore } from "./files-api-secret-store.js";
import { FilesApiSessionStore } from "./files-api-session-store.js";
import { gateSecret } from "./gate-secret.js";
import { workbenchSessionId } from "./session-id.js";
import { newSecretCommand, newSessionCommand } from "./static-commands.js";
import type { Terminal } from "./terminal-contract.js";

const SECRET_NAME = "GEMINI_API_KEY";
const DEFAULT_MODEL: ModelConfig = "google/gemini-2.5-flash";

export interface CreateWorkbenchOptions {
  /** The unwrapped FilesApi (e.g. BrowserFilesApi over a directory handle). */
  rootFiles: FilesApi;
  /** Stable per-workspace identifier used in the session id. */
  workspaceKey: string;
  /**
   * Host-mounted terminal implementing the four-method `Terminal` contract.
   * The workbench writes streaming output here from the `agent` command.
   */
  terminal: Terminal;
  /** Default cwd for the agent's sandbox. Default `/workspace`. */
  cwd?: string;
  /** Model id passed to Flue's harness init. Default `google/gemini-2.5-flash`. */
  defaultModel?: ModelConfig;
  /**
   * Called when `/.settings/secrets.json` lacks `GEMINI_API_KEY`.
   * Resolve with the user-supplied key; reject (or resolve `""`) to
   * abort boot with `WorkbenchSecretMissingError`.
   */
  onSecretRequest: (name: string) => Promise<string>;
  /** Optional Flue tools to expose to the agent. */
  tools?: Record<string, BuildBashTool>;
}

export interface Workbench {
  readonly session: FlueSession;
  readonly harness: FlueHarness;
  readonly secrets: FilesApiSecretStore;
  readonly sessions: FilesApiSessionStore;
  readonly views: FilesViews;
  readonly sessionId: string;
  /** Run a shell command on the human-facing bash. */
  runShell(commandLine: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Release event subscriptions, tear down the harness. */
  dispose(): Promise<void>;
}

/**
 * Compose the workbench in one call. Atomic boot:
 *
 * 1. Split `rootFiles` into system / user views.
 * 2. Gate on `GEMINI_API_KEY` (existing or via `onSecretRequest`).
 * 3. Build the model-facing bash (executor + factory).
 * 4. Construct the Flue context, harness, session.
 * 5. Build the human-facing bash with `agent`/`secret`/`session` commands.
 * 6. Wire `terminal.onData` to feed lines into the human bash.
 *
 * If step 2 rejects, `WorkbenchSecretMissingError` propagates with no
 * `Workbench` exposed and no handlers attached to `terminal.onData`.
 */
export async function createWorkbench(opts: CreateWorkbenchOptions): Promise<Workbench> {
  const cwd = opts.cwd ?? "/workspace";
  const views = buildFilesViews(opts.rootFiles);

  // Ensure the user-side workspace exists so bash commands have a real cwd.
  if (!(await views.userFiles.exists(cwd))) {
    await views.userFiles.mkdir(cwd);
  }

  const secrets = new FilesApiSecretStore({ systemFiles: views.systemFiles });
  const sessions = new FilesApiSessionStore({ files: views.systemFiles });

  // Boot gate — throws WorkbenchSecretMissingError if it fails.
  // Nothing past this point is observable on failure.
  const apiKey = await gateSecret(secrets, SECRET_NAME, opts.onSecretRequest);
  // Patch the pi-ai Google provider with the user-supplied key. Idempotent;
  // last-write-wins per call. Required before `init()` resolves the model.
  configureGemini(apiKey);

  const { factory: bashFactory } = await buildBash({
    files: views.userFiles,
    cwd,
    tools: opts.tools,
  });

  const env: Record<string, string> = {
    ...(await secrets.asEnv()),
    GEMINI_API_KEY: apiKey,
  };

  const agentConfig: AgentConfig = {
    systemPrompt: "",
    skills: {},
    roles: {},
    model: resolveModel(opts.defaultModel ?? DEFAULT_MODEL),
    resolveModel,
  };

  const ctx: FlueContextInternal = createFlueContext({
    id: opts.workspaceKey,
    runId: crypto.randomUUID(),
    payload: {},
    env,
    agentConfig,
    createDefaultEnv: async (): Promise<SessionEnv> => bashFactoryToSessionEnv(bashFactory),
    defaultStore: sessions,
  });

  const harness = await ctx.init({
    model: opts.defaultModel ?? DEFAULT_MODEL,
    sandbox: bashFactory,
    persist: sessions,
    cwd,
  });

  const sessionId = workbenchSessionId(opts.workspaceKey);
  const session = await harness.session(sessionId);

  // Human-facing bash — shares the same FilesApi root as the model bash, but
  // carries the human-only `agent`, `secret`, `session` commands.
  const humanBash = new Bash({
    fs: new FilesApiAdapter({ files: views.userFiles, cwd }),
    cwd,
    customCommands: [
      newAgentCommand({
        session: () => session,
        subscribeEvent: ctx.subscribeEvent,
        term: opts.terminal,
      }),
      newSecretCommand({ secrets }),
      newSessionCommand({ sessions, sessionId }),
    ],
  });

  // Wire terminal input → human bash. A complete line (terminated by \r or \n)
  // is executed; output is streamed back to the terminal. Ctrl-C is reserved
  // for the in-flight `agent` command; the input-handler itself is the
  // production-grade port (task 6.2) and replaces this minimal loop.
  const lineBuffer: string[] = [];
  const inputDisposer = opts.terminal.onData(async (chunk) => {
    for (const ch of chunk) {
      if (ch === "\r" || ch === "\n") {
        const line = lineBuffer.join("").trim();
        lineBuffer.length = 0;
        opts.terminal.write("\r\n");
        if (!line) continue;
        try {
          const r = await humanBash.exec(line);
          if (r.stdout) opts.terminal.write(r.stdout.replace(/\n/g, "\r\n"));
          if (r.stderr) {
            opts.terminal.write(`\x1b[31m${r.stderr.replace(/\n/g, "\r\n")}\x1b[0m`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts.terminal.write(`\x1b[31m${msg}\r\n\x1b[0m`);
        }
      } else if (ch === "" || ch === "\b") {
        if (lineBuffer.length > 0) {
          lineBuffer.pop();
          opts.terminal.write("\b \b");
        }
      } else {
        lineBuffer.push(ch);
        opts.terminal.write(ch);
      }
    }
  });

  return {
    session,
    harness,
    secrets,
    sessions,
    views,
    sessionId,
    async runShell(commandLine) {
      return humanBash.exec(commandLine);
    },
    async dispose() {
      inputDisposer.dispose();
    },
  };
}
