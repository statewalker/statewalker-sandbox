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
  // for the in-flight `agent` command; a production-grade input-handler port
  // (task 6.2) replaces this minimal loop in a follow-up.
  //
  // SHELL-STATE PERSISTENCE
  // -----------------------
  // `Bash.exec()` builds a copy of `this.state` for each call and runs the
  // script against the copy — internal `cd` / `export FOO=bar` mutations are
  // thrown away when the call returns. Without compensation, typing `cd /foo`
  // then `ls` would list the constructor cwd, not `/foo`.
  //
  // The fix:
  //   1. Maintain our own `currentCwd` + `currentEnv` between calls.
  //   2. Append a cwd probe (`; printf '\x01CWD:%s\x01' "$(pwd)"`) to every
  //      script so the post-execution cwd shows up at the end of stdout.
  //      `\x01` is SOH — it never appears in normal command output, so the
  //      marker is unambiguous and easy to strip before display.
  //   3. Pass `{ cwd, env }` into every `exec()` so the user-visible state
  //      threads forward. `env` comes from `BashExecResult.env` directly
  //      (already exposes the post-script env, including `export`s).
  let currentCwd = cwd;
  let currentEnv: Record<string, string> | undefined;
  // \x01 (SOH) is the sentinel — chosen because it never appears in real
  // command output, so the marker is unambiguous and easy to strip.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional SOH sentinel
  const CWD_MARKER_RE = /\x01CWD:(.*?)\x01/;
  const CWD_PROBE = `; printf '\\x01CWD:%s\\x01' "$(pwd)"`;
  const runShellLine = async (line: string) => {
    const r = await humanBash.exec(`{ ${line}; } ${CWD_PROBE}`, {
      cwd: currentCwd,
      env: currentEnv,
      replaceEnv: currentEnv !== undefined,
    });
    let stdout = r.stdout;
    const m = CWD_MARKER_RE.exec(stdout);
    if (m?.[1]) {
      currentCwd = m[1];
      stdout = stdout.replace(CWD_MARKER_RE, "");
    }
    currentEnv = r.env;
    return { ...r, stdout };
  };

  // Shell-style prompt: cyan `flue-workbench:<cwd>$`. Re-read every time so
  // the cwd reflects the most recent `cd`. The reset (`\x1b[0m`) immediately
  // follows the `$` so the user's typed text is rendered in the default
  // terminal colour, not cyan.
  const writePrompt = () => {
    opts.terminal.write(`\x1b[36mflue-workbench\x1b[0m:${currentCwd} $ `);
  };
  // Initial prompt — written once after the banner so the user sees a ready
  // input line as soon as createWorkbench resolves.
  writePrompt();

  const lineBuffer: string[] = [];
  const inputDisposer = opts.terminal.onData(async (chunk) => {
    for (const ch of chunk) {
      if (ch === "\r" || ch === "\n") {
        const line = lineBuffer.join("").trim();
        lineBuffer.length = 0;
        opts.terminal.write("\r\n");
        if (!line) {
          writePrompt();
          continue;
        }
        try {
          const r = await runShellLine(line);
          if (r.stdout) opts.terminal.write(r.stdout.replace(/\n/g, "\r\n"));
          if (r.stderr) {
            opts.terminal.write(`\x1b[31m${r.stderr.replace(/\n/g, "\r\n")}\x1b[0m`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts.terminal.write(`\x1b[31m${msg}\r\n\x1b[0m`);
        }
        writePrompt();
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
      // Use the same state-preserving helper as the terminal input loop so
      // programmatic shell calls share cwd/env with what the user types.
      return runShellLine(commandLine);
    },
    async dispose() {
      inputDisposer.dispose();
    },
  };
}
