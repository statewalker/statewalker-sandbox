import type { FilesApi } from "@statewalker/webrun-files";
import { FilteredFilesApi, newPathFilter } from "@statewalker/webrun-files-composite";

/**
 * Root of the system-only subtree. Stores secrets, session history,
 * and any other configuration that must never reach the model.
 */
export const SYSTEM_PREFIX = "/.settings";

export interface FilesViews {
  /** The unwrapped original FilesApi — host-only handle for diagnostics. */
  rootFiles: FilesApi;
  /** Sees only paths under `/.settings/**`. Used for SecretStore + SessionStore. */
  systemFiles: FilesApi;
  /** Sees everything except `/.settings/**`. The model-visible workspace. */
  userFiles: FilesApi;
}

/**
 * Split a single `rootFiles` into three views via `FilteredFilesApi`:
 *
 * - `systemFiles`: visible only for `/.settings` and its descendants.
 * - `userFiles`: visible for everything **except** `/.settings/**`.
 * - `rootFiles`: the original, unwrapped — for callers that need both halves.
 *
 * The system view is exclusive (visibility = match), the user view is
 * inverse (visibility = no-match) — both built on the same `newPathFilter`
 * helper for symmetry.
 */
export function buildFilesViews(rootFiles: FilesApi): FilesViews {
  // Visibility predicate for the system view: root must be visible so that
  // listing `/` can enumerate `.settings` as a child; everything else outside
  // the `/.settings/**` subtree is hidden.
  const isSystemPath = (p: string): boolean =>
    p === "/" || p === SYSTEM_PREFIX || p.startsWith(`${SYSTEM_PREFIX}/`);

  return {
    rootFiles,
    systemFiles: new FilteredFilesApi(rootFiles, isSystemPath),
    userFiles: new FilteredFilesApi(rootFiles, newPathFilter(SYSTEM_PREFIX)),
  };
}
