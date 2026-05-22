import type { AgentConfig, ModelConfig, SessionEnv } from "@flue/runtime";
import {
  bashFactoryToSessionEnv,
  createFlueContext,
  type FlueContextInternal,
  resolveModel,
} from "@flue/runtime/internal";
import type { ExecutorToolDef } from "@just-bash/executor";
import type { FilesApi } from "@statewalker/webrun-files";
import { buildBash } from "./build-bash.js";
import { buildFilesViews } from "./build-files-views.js";
import { configureGemini } from "./configure-gemini.js";
import { FilesApiSecretStore } from "./files-api-secret-store.js";
import { FilesApiSessionStore } from "./files-api-session-store.js";
import { gateSecret } from "./gate-secret.js";
import { newAgentCommand, newSecretCommand, newSessionCommand } from "./human-commands.js";
import { attachHumanShell } from "./human-shell.js";
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
  tools?: Record<string, ExecutorToolDef>;
}

export interface Workbench {
  /**
   * Detach the human shell's `onData` listener from the terminal.
   *
   * The Flue runtime exposes no harness/session/context teardown API, so the
   * harness and its model connection are NOT torn down here — they survive
   * until the JS context (the tab/worker) goes away. Call this before
   * disposing the terminal to stop input events from firing on a dead bash.
   */
  dispose(): void;
}

/**
 * Compose the workbench in one call. Atomic boot:
 *
 * 1. Split `rootFiles` into system / user views.
 * 2. Gate on `GEMINI_API_KEY` (existing or via `onSecretRequest`).
 * 3. Build the model-facing bash (executor + factory).
 * 4. Construct the Flue context, harness, session.
 * 5. Attach the human-facing shell with `agent`/`secret`/`session` commands.
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

  const bashFactory = await buildBash({
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

  // Session id format: `workbench/<key>/main`. Slashes in the workspace key
  // are URL-encoded so the three-part id stays well-formed. The trailing
  // `main` slot is reserved for future multi-session support without a
  // storage-path format break.
  if (!opts.workspaceKey) {
    throw new Error("createWorkbench: workspaceKey must be a non-empty string");
  }
  const sessionId = `workbench/${opts.workspaceKey.replace(/\//g, "%2F")}/main`;
  const session = await harness.session(sessionId);

  const shell = attachHumanShell({
    files: views.userFiles,
    cwd,
    terminal: opts.terminal,
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

  return { dispose: shell.dispose };
}
