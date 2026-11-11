/** X10a — the LFS client: Batch API and basic transfer, resumable, verified (red stub). */
import type { Pointer } from "./pointer.js";
import type { LfsStore } from "./store.js";

export interface LfsClientOptions {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** bytes sent or received in transfer bodies */
  stats?: { bytes: number };
}
/** `url`: the git remote (…/repo.git); the LFS endpoint is `<url>/info/lfs` */
export async function lfsPush(
  _url: string,
  _store: LfsStore,
  _objects: Pointer[],
  _opts?: LfsClientOptions,
): Promise<{ uploaded: string[]; skipped: string[] }> {
  throw new Error("not implemented");
}
export async function lfsFetch(
  _url: string,
  _store: LfsStore,
  _objects: Pointer[],
  _opts?: LfsClientOptions,
): Promise<{ downloaded: string[] }> {
  throw new Error("not implemented");
}
