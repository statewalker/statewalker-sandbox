import type { FilesApi } from "@statewalker/webrun-files";
import type { Event } from "@theia/core/lib/common/event";

/**
 * DI key for the FilesApi the app shows. Bind it in the app's own frontend
 * module to a function that returns (or resolves to) the FilesApi:
 *
 *   rebind(FilesApiSource).toConstantValue(() => myFilesApi);
 */
export const FilesApiSource = Symbol("FilesApiSource");
export type FilesApiSource = () => FilesApi | Promise<FilesApi>;

/** DI key for the URI opened as the workspace when none was opened before. */
export const FilesApiWorkspaceRoot = Symbol("FilesApiWorkspaceRoot");
export type FilesApiWorkspaceRoot = string;

/** DI key for the label shown for the FilesApi root (instead of "/"). */
export const FilesApiRootLabel = Symbol("FilesApiRootLabel");
export type FilesApiRootLabel = string;

/** A change made to the FilesApi by someone other than the Theia provider. */
export interface FilesApiChange {
  type: "added" | "updated" | "deleted";
  path: string;
}

/**
 * Optional DI key: an event of changes the provider cannot see (a mount
 * appearing, a filter changing). When bound, the provider forwards it to Theia.
 */
export const FilesApiChanges = Symbol("FilesApiChanges");
export type FilesApiChanges = Event<readonly FilesApiChange[]>;
