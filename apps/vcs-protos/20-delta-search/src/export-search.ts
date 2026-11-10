/** X6e — delta search in export — red stub. */
import type { Repository } from "../../17-repository/src/object-store.js";
import type { ToSend, WalkOptions } from "../../18-pack-export/src/export.js";
import type { ReuseOptions } from "../../19-delta-reuse/src/export-reuse.js";

export interface SearchStats {
  candidates: number;
  computed: number;
  comparisons: number;
  /** content bytes the window held at most */
  peakWindowBytes: number;
  /** candidates above bigFileThreshold (never delta'd, never buffered) */
  big: number;
}
export interface SearchOptions extends ReuseOptions {
  window?: number;
  depth?: number;
  windowMemory?: number;
  bigFileThreshold?: number;
  searchStats?: SearchStats;
}
export function nameHash(_path: string): number {
  throw new Error("not implemented");
}
export function writePackSearching(
  _repo: Repository,
  _objects: ToSend[],
  _opts: SearchOptions & { receiverHas?: (oid: string) => boolean; edges?: string[] } = {},
): AsyncGenerator<Uint8Array> {
  throw new Error("not implemented");
}
export function exportPackSearching(
  _repo: Repository,
  _wants: string[],
  _haves: string[],
  _opts: SearchOptions & WalkOptions = {},
): AsyncGenerator<Uint8Array> {
  throw new Error("not implemented");
}
