/** X6b1 — red stub. */
import type { FilesApi } from "@statewalker/webrun-files";
import { PackError } from "../../12-index-pack/src/index-pack.js";

export { PackError };
export type ObjectTypeName = "commit" | "tree" | "blob" | "tag";
export type ExternalBase = (
  oid: string,
) => Promise<{ type: ObjectTypeName; data: Uint8Array } | undefined>;
export interface IndexedEntry {
  oid: string;
  offset: number;
  crc32: number;
  type: ObjectTypeName;
  size: number;
}
export interface InstallOptions {
  maxObjectSize?: number;
  baseCacheBytes?: number;
  maxPackSize?: number;
  externalBase?: ExternalBase;
  windowBytes?: number;
}
export interface InstallResult {
  packId: string;
  count: number;
  idx: Uint8Array;
  readonly entries: IndexedEntry[];
  stats: { appended: number; storageReads: number; deltaLoads: number };
}
export async function installPack(
  _files: FilesApi,
  _packDir: string,
  _source: AsyncIterable<Uint8Array>,
  _opts: InstallOptions = {},
): Promise<InstallResult> {
  throw new Error("not implemented");
}
export function writeIdx(_entries: IndexedEntry[], _packId: string): Uint8Array {
  throw new Error("not implemented");
}
export async function sweepPackTemporaries(
  _files: FilesApi,
  _packDir: string,
  _opts: { olderThanMs: number; now?: number },
): Promise<string[]> {
  throw new Error("not implemented");
}
