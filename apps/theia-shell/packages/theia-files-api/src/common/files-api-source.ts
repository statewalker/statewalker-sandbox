import type { FilesApi } from "@statewalker/webrun-files";

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
