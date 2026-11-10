/** X8b — a smart-HTTP push client — red stub. */
import type { Repository } from "../../17-repository/src/object-store.js";
export interface PushResult {
  ref: string;
  ok: boolean;
  reason?: string;
}
export interface PushOptions {
  refspecs: string[];
  atomic?: boolean;
  pushOptions?: string[];
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** bytes of the request body sent (commands and pack) */
  stats?: { bytes: number };
}
export async function push(
  _url: string,
  _repo: Repository,
  _opts: PushOptions,
): Promise<PushResult[]> {
  throw new Error("not implemented");
}
