/** Backends: each composes an ObjectStore and X5's RefDb. */
import type { Db } from "@statewalker/db-api";
import type { FilesApi } from "@statewalker/webrun-files";
import type { RefFiles } from "../../10-ref-transactions/src/files-ref-db.js";
import type { RefDb } from "../../10-ref-transactions/src/ref-db.js";
import type { ObjectStore } from "./object-store.js";

export interface Repository {
  objects: ObjectStore;
  refs: RefDb;
}
export async function filesRepository(
  _files: FilesApi,
  _refFiles: RefFiles,
  _objectsDir = "/objects",
): Promise<Repository> {
  throw new Error("not implemented");
}
export async function sqlRepository(_db: Db): Promise<Repository> {
  throw new Error("not implemented");
}
