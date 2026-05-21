/**
 * Public surface of the `flue-workbench` integration library.
 *
 * Canonical entry: `createWorkbench(opts)` — composes everything the
 * workbench app needs from a `FilesApi`, a `Terminal`, and an
 * `onSecretRequest` callback.
 *
 * Piecewise factories below are exported for power users assembling
 * non-default compositions (e.g. a Node demo, an alternate terminal
 * emulator, a custom secret prompt UI). Their surface is **not stable
 * across minor versions** — reach past `createWorkbench` only if you
 * are tracking internal moves.
 */

// ── Piecewise (internal — subject to change) ───────────────────────
export { type NewAgentCommandOptions, newAgentCommand } from "./agent-command.js";
export { type FilesApiBashFactoryOptions, filesApiBashFactory } from "./bash-factory.js";
export {
  type BuildBashOptions,
  type BuildBashResult,
  type BuildBashTool,
  buildBash,
} from "./build-bash.js";
export { buildFilesViews, type FilesViews, SYSTEM_PREFIX } from "./build-files-views.js";
export { configureGemini, GEMINI_PROVIDER } from "./configure-gemini.js";
// ── Canonical entry ────────────────────────────────────────────────
export {
  type CreateWorkbenchOptions,
  createWorkbench,
  type Workbench,
} from "./create-workbench.js";
// ── Stable error type ──────────────────────────────────────────────
export { WorkbenchSecretMissingError } from "./errors.js";
export { FilesApiAdapter, type FilesApiAdapterOptions } from "./files-api-adapter.js";
export { FilesApiSecretStore, type FilesApiSecretStoreOptions } from "./files-api-secret-store.js";
export {
  FilesApiSessionStore,
  type FilesApiSessionStoreOptions,
  type SessionDataLike,
} from "./files-api-session-store.js";
export { gateSecret } from "./gate-secret.js";
export { workbenchSessionId } from "./session-id.js";
export { newSecretCommand, newSessionCommand } from "./static-commands.js";
// ── Terminal contract ──────────────────────────────────────────────
export type { Terminal } from "./terminal-contract.js";
