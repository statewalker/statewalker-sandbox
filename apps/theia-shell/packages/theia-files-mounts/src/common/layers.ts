import type { FilesApi } from "@statewalker/webrun-files";
import {
  FilteredFilesApi,
  newGlobPathFilter,
  newPathFilter,
} from "@statewalker/webrun-files-composite";
import type { Event } from "@theia/core/lib/common/event";

/** A wrapper around the mount composite. Bind with `bind(FilesApiLayer).to…`. */
export const FilesApiLayer = Symbol("FilesApiLayer");
export interface FilesApiLayer {
  readonly id: string;
  /** Lower wraps first (closer to the composite). */
  readonly priority: number;
  wrap(root: FilesApi): FilesApi;
  /** Fires when `wrap` would now wrap differently. */
  readonly onDidChange?: Event<void>;
}

export function applyLayers(root: FilesApi, layers: readonly FilesApiLayer[]): FilesApi {
  return [...layers]
    .sort((a, b) => a.priority - b.priority)
    .reduce((api, layer) => layer.wrap(api), root);
}

/**
 * Hides every path matching one of `globs`; no globs → the api itself. A glob
 * that is not a string or does not compile is skipped and passed to `onInvalid`,
 * so one typo in settings never breaks the whole tree.
 */
export function hiddenPathsFilter(
  globs: readonly unknown[],
  onInvalid: (glob: unknown) => void = () => {},
): (api: FilesApi) => FilesApi {
  const valid = globs.filter((glob): glob is string => {
    try {
      if (typeof glob !== "string") throw new Error("not a string");
      // Compile it the way the filter will, and use it once.
      void newGlobPathFilter(glob)("/");
      return true;
    } catch {
      onInvalid(glob);
      return false;
    }
  });
  return (api) => (valid.length ? new FilteredFilesApi(api, newGlobPathFilter(...valid)) : api);
}

/** Hides one folder and everything in it; no path → the api itself. */
export function systemFolderFilter(path: string | undefined): (api: FilesApi) => FilesApi {
  return (api) => (path ? new FilteredFilesApi(api, newPathFilter(path)) : api);
}
