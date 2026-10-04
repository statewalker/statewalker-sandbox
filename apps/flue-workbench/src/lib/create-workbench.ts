import { type FlueEvent, init, observe } from "@flue/runtime";
import { type Flue, start } from "@flue/runtime/node";
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
import { createWorkbenchAgent } from "./workbench-agent.js";

const SECRET_NAME = "GEMINI_API_KEY";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

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
  /** Model specifier for the agent. Default `google/gemini-2.5-flash`. */
  defaultModel?: string;
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
   * Detach the human shell's `onData` listener from the terminal and stop
   * the Flue runtime (Flue 2's `start()` handle drains in-flight work, then
   * disconnects persistence). Call this before disposing the terminal so no
   * input events fire on a dead bash, and before booting another workbench
   * in the same tab — one JS context holds at most one Flue runtime.
   */
  dispose(): Promise<void>;
}

/**
 * Compose the workbench in one call. Atomic boot:
 *
 * 1. Split `rootFiles` into system / user views.
 * 2. Gate on `GEMINI_API_KEY` (existing or via `onSecretRequest`).
 * 3. Build the model-facing bash (executor + factory) and the agent function.
 * 4. Start the Flue runtime over the FilesApi-backed persistence adapter.
 * 5. Attach the human-facing shell with `agent`/`secret`/`session` commands.
 *
 * If step 2 rejects, `WorkbenchSecretMissingError` propagates with no
 * `Workbench` exposed and no handlers attached to `terminal.onData`.
 */
export async function createWorkbench(opts: CreateWorkbenchOptions): Promise<Workbench> {
  if (!opts.workspaceKey) {
    throw new Error("createWorkbench: workspaceKey must be a non-empty string");
  }
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
  // Register the Gemini provider with the user-supplied key. Idempotent;
  // last-write-wins per call. Must precede the first model call.
  configureGemini(apiKey);

  const bashFactory = await buildBash({
    files: views.userFiles,
    cwd,
    tools: opts.tools,
  });
  const agent = createWorkbenchAgent({
    model: opts.defaultModel ?? DEFAULT_MODEL,
    bashFactory,
  });

  // Session id format: `workbench/<key>/main` — in Flue 2 this is the agent
  // *instance id*, which keys the persisted conversation. Slashes in the
  // workspace key are URL-encoded so the three-part id stays well-formed.
  // The trailing `main` slot is reserved for future multi-session support
  // without a storage-path format break.
  const sessionId = `workbench/${opts.workspaceKey.replace(/\//g, "%2F")}/main`;

  const env: Record<string, string> = {
    ...(await secrets.asEnv()),
    GEMINI_API_KEY: apiKey,
  };

  // `start()` is Flue 2's documented bootstrap for running agents outside a
  // generated Flue server: it registers the agent, connects persistence and
  // starts the durable submission coordinator. `providers: []` keeps it from
  // registering every pi-ai built-in — `configureGemini` already registered
  // the only provider the workbench uses.
  const startRuntime = (): Promise<Flue> =>
    start({ agents: [agent], db: sessions, env, providers: [] });

  let runtime = await startRuntime();
  // An address, not a resource: `init()` performs no I/O. Re-created after a
  // reset because a handle pins the instance incarnation it first contacted.
  let instance = init(agent, { id: sessionId });

  // `session reset` must wipe the conversation, but Flue 2's stores have no
  // per-session delete and the live runtime caches conversation state. So:
  // stop the runtime, delete the files, start a fresh runtime that reloads
  // from disk.
  const resettableSessions = {
    delete: async (id: string) => {
      await runtime.stop();
      try {
        await sessions.delete(id);
      } finally {
        runtime = await startRuntime();
        instance = init(agent, { id: sessionId });
      }
    },
  };

  let shell: ReturnType<typeof attachHumanShell>;
  try {
    shell = attachHumanShell({
      files: views.userFiles,
      cwd,
      terminal: opts.terminal,
      customCommands: [
        newAgentCommand({
          instance: () => instance,
          subscribeEvent: (cb) => subscribeInstanceEvents(sessionId, cb),
          term: opts.terminal,
        }),
        newSecretCommand({ secrets }),
        newSessionCommand({ sessions: resettableSessions, sessionId }),
      ],
    });
  } catch (err) {
    await runtime.stop();
    throw err;
  }

  return {
    dispose: async () => {
      shell.dispose();
      await runtime.stop();
    },
  };
}

/**
 * Forward the live events of one agent instance. Flue 2's `observe()` is
 * process-global (every agent, every instance); filtering on the instance
 * id keeps unrelated activity out of the terminal.
 */
function subscribeInstanceEvents(instanceId: string, cb: (event: FlueEvent) => void): () => void {
  return observe((event) => {
    if (event.instanceId === instanceId) cb(event);
  });
}
