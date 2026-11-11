/** X12 — LFS on an httpeers peer, behind its mesh roles (red stub). */
import type { ruleSet } from "@statewalker/httpeers-access";
import type { Repository } from "../../17-repository/src/object-store.js";
import type { LfsStore } from "../../26-lfs/src/store.js";

export interface MeshLfsOptions {
  issuer: string;
  rules?: ReturnType<typeof ruleSet>;
}
export function meshLfsHandler(
  _store: LfsStore,
  _opts: MeshLfsOptions,
): (req: Request) => Promise<Response> {
  throw new Error("not implemented");
}
/** git and LFS at one mount */
export function meshRepoHandler(
  _repo: Repository,
  _opts: MeshLfsOptions,
): (req: Request) => Promise<Response> {
  throw new Error("not implemented");
}
