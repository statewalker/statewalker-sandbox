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

/** Hides every path matching one of `globs`; no globs → the api itself. */
export function hiddenPathsFilter(globs: readonly string[]): (api: FilesApi) => FilesApi {
  return (api) => (globs.length ? new FilteredFilesApi(api, newGlobPathFilter(...globs)) : api);
}

/** Hides one folder and everything in it; no path → the api itself. */
export function systemFolderFilter(path: string | undefined): (api: FilesApi) => FilesApi {
  return (api) => (path ? new FilteredFilesApi(api, newPathFilter(path)) : api);
}
