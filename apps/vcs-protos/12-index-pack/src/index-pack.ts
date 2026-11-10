/** X6a — index-pack over FilesApi. Stub in red. */
import type { FilesApi } from "@statewalker/webrun-files";

export class PackError extends Error {
  override name = "PackError";
}

export interface IndexedEntry {
  oid: string;
  offset: number;
  crc32: number;
  type: "commit" | "tree" | "blob" | "tag";
  size: number;
}

export interface InstallResult {
  /** hex SHA-1 of the pack (its trailer); files are pack-<packId>.pack / .idx */
  packId: string;
  entries: IndexedEntry[];
  idx: Uint8Array;
}

/**
 * Write `source` to `<packDir>/tmp_pack_*`, index it, write `tmp_idx_*`, then rename the pack and,
 * last, the idx into place. On any error every temporary is removed and nothing is installed.
 */
export async function installPack(
  _files: FilesApi,
  _packDir: string,
  _source: AsyncIterable<Uint8Array>,
): Promise<InstallResult> {
  throw new Error("not implemented");
}
