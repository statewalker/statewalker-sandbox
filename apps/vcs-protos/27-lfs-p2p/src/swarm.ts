/** X12 — a download from every peer that holds the object (red stub). */
import type { Pointer } from "../../26-lfs/src/pointer.js";
import type { LfsStore } from "../../26-lfs/src/store.js";

export interface LfsSource {
  name: string;
  /** the peer's git remote URL (…/repo.git) */
  url: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}
export interface SwarmOptions {
  /** bytes per ranged request (default 4 MiB) */
  chunkSize?: number;
  /** bytes received per source */
  stats?: Record<string, number>;
  signal?: AbortSignal;
}
export async function lfsFetchFrom(
  _sources: LfsSource[],
  _store: LfsStore,
  _objects: Pointer[],
  _opts?: SwarmOptions,
): Promise<{ downloaded: string[]; bad: string[] }> {
  throw new Error("not implemented");
}
