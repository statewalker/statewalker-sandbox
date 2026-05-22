/**
 * Public surface of the `flue-workbench` integration library.
 *
 * `createWorkbench(opts)` composes everything the workbench app needs from a
 * `FilesApi`, a `Terminal`, and an `onSecretRequest` callback.
 *
 * Library-internal modules (FilesApiAdapter, FilesApiSecretStore,
 * FilesApiSessionStore, gateSecret, buildFilesViews, buildBash, etc.) are
 * deliberately not re-exported. They are implementation details — tests
 * reach them by file path; no external caller should.
 */

export {
  type CreateWorkbenchOptions,
  createWorkbench,
  type Workbench,
} from "./create-workbench.js";
export { WorkbenchSecretMissingError } from "./errors.js";
export type { Terminal } from "./terminal-contract.js";
