/** X8c — git on an httpeers peer — red stub. */
import type { Repository } from "../../17-repository/src/object-store.js";
export interface MeshGitOptions {
  /** the mesh's issuer (the hub's peerId) */
  issuer: string;
  /** extra roles → capabilities rules (defaults: reader, member, maintainer) */
  rules?: unknown;
}
export function meshGitHandler(
  _repo: Repository,
  _opts: MeshGitOptions,
): (req: Request) => Promise<Response> {
  return async () => {
    throw new Error("not implemented");
  };
}
/** A fetch that calls `peer` over a remote (createRemoteOverLink) with a membership token. */
export function meshFetch(
  _call: (peer: string, req: Request) => Promise<Response>,
  _peer: string,
  _token: string,
): typeof fetch {
  throw new Error("not implemented");
}
