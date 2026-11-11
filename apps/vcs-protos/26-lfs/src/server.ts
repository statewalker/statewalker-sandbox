/** X10a — the LFS Batch API and basic transfer as a fetch handler (red stub). */
import type { LfsStore } from "./store.js";

export type LfsOperation = "download" | "upload";
export interface LfsServerOptions {
  /** per batch: true, or a refusal (401: credentials needed; 403: not allowed) */
  authorize?: (
    req: Request,
    operation: LfsOperation,
  ) => Promise<true | { status: 401 | 403; message: string }>;
  /** headers an action carries, and their check on the transfer request (scoped per object) */
  transferAuth?: {
    headers(operation: LfsOperation, oid: string): Promise<Record<string, string>>;
    check(req: Request, operation: LfsOperation, oid: string): Promise<boolean>;
  };
}
export function isLfsRequest(_req: Request): boolean {
  throw new Error("not implemented");
}
export function lfsHandler(
  _store: LfsStore,
  _opts?: LfsServerOptions,
): (req: Request) => Promise<Response> {
  throw new Error("not implemented");
}
/** one URL: LFS requests to `lfs`, the rest to `git` */
export function withLfs(
  _git: (req: Request) => Promise<Response>,
  _lfs: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  throw new Error("not implemented");
}
