/** X6r — reading objects from an installed pack (idx v2 + pack). Stub in red. */
import type { FilesApi } from "@statewalker/webrun-files";
import type { ByteStream } from "@statewalker/webrun-storage";

export type ObjectTypeName = "commit" | "tree" | "blob" | "tag";
export interface ReadObject {
  type: ObjectTypeName;
  size: number;
  content: ByteStream;
}
export interface PackReaderOptions {
  /** Bytes of resolved delta bases kept across reads (git's delta_base_cache_limit). Default 16 MiB. */
  baseCacheBytes?: number;
}
export interface PackReader {
  readonly packId: string;
  readonly count: number;
  has(oid: string): boolean;
  /** Undefined when the pack does not contain `oid`. */
  get(oid: string, opts?: { verify?: boolean }): Promise<ReadObject | undefined>;
  ids(): Iterable<string>;
  /** Counters for tests: entry inflations performed. */
  readonly stats: { inflations: number };
}

export async function openPack(
  _files: FilesApi,
  _packPath: string,
  _idxPath: string,
  _opts: PackReaderOptions = {},
): Promise<PackReader> {
  throw new Error("not implemented");
}
