import type { FilesApi } from "@statewalker/webrun-files";
import { FilteredFilesApi, newPathFilter } from "@statewalker/webrun-files-composite";

/**
 * Root of the system-only subtree. Stores secrets, session history,
 * and any other configuration that must never reach the model.
 */
export const SYSTEM_PREFIX = "/.settings";

export interface FilesViews {
  /** Sees only paths under `/.settings/**`. Used for SecretStore + SessionStore. */
  systemFiles: FilesApi;
  /** Sees everything except `/.settings/**`. The model-visible workspace. */
  userFiles: FilesApi;
}

/**
 * Split a single `rootFiles` into two filtered views:
 *
 * - `systemFiles`: visible only for `/.settings` and its descendants.
 * - `userFiles`: visible for everything **except** `/.settings/**`.
 *
 * The system view is exclusive (visibility = match), the user view is
 * inverse (visibility = no-match) — both built on the same `newPathFilter`
 * helper for symmetry. Callers that need the unwrapped root keep their own
 * reference to the argument they pass in.
 */
export function buildFilesViews(rootFiles: FilesApi): FilesViews {
  const isSystemPath = (p: string): boolean =>
    p === SYSTEM_PREFIX || p.startsWith(`${SYSTEM_PREFIX}/`);

  return {
    systemFiles: new FilteredFilesApi(rootFiles, isSystemPath),
    userFiles: new FilteredFilesApi(rootFiles, newPathFilter(SYSTEM_PREFIX)),
  };
}
