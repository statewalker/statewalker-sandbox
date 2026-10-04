import {
  type Agent,
  type BashFactory,
  bash,
  GeneralSubagent,
  useModel,
  useSandbox,
  useSubagent,
} from "@flue/runtime";

/**
 * Durable identity of the workbench agent. Flue 2 keys conversation storage
 * by (agent name, instance id); pinning the name as a static keeps it stable
 * even though Vite's minifier renames the function in production builds.
 */
export const WORKBENCH_AGENT_NAME = "flue-workbench";

export interface CreateWorkbenchAgentOptions {
  /** Model specifier, e.g. `google/gemini-2.5-flash`. */
  model: string;
  /** Model-facing bash (typically from `buildBash`). */
  bashFactory: BashFactory;
  /** System instructions. Default: none (Flue's built-in tool docs only). */
  instructions?: string;
}

/**
 * Build the workbench's Flue 2 agent function.
 *
 * Flue 2 replaced the 0.7 `AgentConfig` bag with an agent *function* whose
 * hooks declare its capabilities; the runtime re-renders it before every
 * model turn. The workbench agent declares:
 *
 * - `useModel` — the Gemini model (provider registered by `configureGemini`).
 * - `useSandbox(bash(...))` — the FilesApi-backed just-bash, which gives the
 *   model Flue's standard `read`/`write`/`edit`/`bash`/`grep`/`glob` tools
 *   over the user's workspace.
 * - `useSubagent(GeneralSubagent)` — Flue 2's `task` tool only delegates to
 *   declared subagents; the blank general-purpose delegate restores 0.7's
 *   "spawn a fresh-context task" capability.
 *
 * Normally Flue registers agents through a build-time `'use agent'` scan;
 * the workbench has no Flue build step (it is a plain Vite browser app), so
 * the function is handed to `start({ agents })` directly, which is the
 * documented registration path outside a Flue build.
 */
export function createWorkbenchAgent(opts: CreateWorkbenchAgentOptions): Agent {
  // Built once: the factory value is cheap, but there is no reason to
  // allocate a new one on every render.
  const sandbox = bash(opts.bashFactory);

  function WorkbenchAgent(): string | undefined {
    useModel(opts.model);
    useSandbox(sandbox);
    useSubagent(GeneralSubagent);
    return opts.instructions;
  }

  return Object.assign(WorkbenchAgent, { agentName: WORKBENCH_AGENT_NAME });
}
