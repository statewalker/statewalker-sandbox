/** X6d — red stub. */

import type { Repository } from "../../17-repository/src/object-store.js";
import type { ToSend } from "../../18-pack-export/src/export.js";

export interface ReuseStats {
  reusedWhole: number;
  reusedDelta: number;
  thinDelta: number;
  deflated: number;
}
export interface ReuseOptions {
  signal?: AbortSignal;
  /** send deltas against objects the receiver has (REF_DELTA; completed with --fix-thin) */
  thin?: boolean;
  stats?: ReuseStats;
}
export function writePackReusing(
  _repo: Repository,
  _objects: ToSend[],
  _opts: ReuseOptions & { receiverHas?: (oid: string) => boolean } = {},
): AsyncGenerator<Uint8Array> {
  throw new Error("not implemented");
}
export function exportPackReusing(
  _repo: Repository,
  _wants: string[],
  _haves: string[],
  _opts: ReuseOptions = {},
): AsyncGenerator<Uint8Array> {
  throw new Error("not implemented");
}
