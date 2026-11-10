/** X6r — git's object database: loose objects (X4) + every installed pack. Stub in red. */
import type { FilesApi } from "@statewalker/webrun-files";
import type { PackReaderOptions, ReadObject } from "./pack-reader.js";

export interface ObjectDatabase {
  get(oid: string, opts?: { verify?: boolean }): Promise<ReadObject | undefined>;
  has(oid: string): Promise<boolean>;
  list(): AsyncIterable<string>;
}

/** `objectsDir` is the repository's objects directory (e.g. "/.git/objects"). */
export async function openObjectDatabase(
  _files: FilesApi,
  _objectsDir: string,
  _opts: PackReaderOptions = {},
): Promise<ObjectDatabase> {
  throw new Error("not implemented");
}
