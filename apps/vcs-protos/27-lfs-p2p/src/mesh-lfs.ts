/**
 * X12 — LFS on an httpeers peer: X10a's Batch API and transfers behind httpeers' access middleware,
 * with the `ranged` adapter on (short requests: the bridge bounds a call until its response head).
 *
 * The capabilities are X8c's, from the mesh roles (`gitRules`): downloads need `git:read`; uploads
 * need `git:write`, or `git:write-own` when the serving peer opts in to contributors (an object is
 * content-addressed: a member's upload is what its own refs, `refs/peers/<id>/*`, point to).
 * `meshRepoHandler` serves git and LFS at one mount.
 */
import { access, type ruleSet, withAccess } from "@statewalker/httpeers-access";
import { ANONYMOUS, lookupPeer } from "@statewalker/httpeers-core";
import type { Repository } from "../../17-repository/src/object-store.js";
import { GIT_RULES, meshGitHandler } from "../../23-git-httpeers/src/mesh-git.js";
import { lfsHandler, withLfs } from "../../26-lfs/src/server.js";
import { type LfsStore, repoLfsStore } from "../../26-lfs/src/store.js";

export interface MeshLfsOptions {
  /** the mesh's issuer (the hub's peerId) */
  issuer: string;
  /** roles → capabilities (default: X8c's GIT_RULES) */
  rules?: ReturnType<typeof ruleSet>;
  /** objects larger are refused */
  maxObjectSize?: number;
}

export function meshLfsHandler(
  store: LfsStore,
  opts: MeshLfsOptions,
): (req: Request) => Promise<Response> {
  const lfs = lfsHandler(store, {
    ranged: true,
    maxObjectSize: opts.maxObjectSize,
    authorize: async (req, op) => {
      const caps = access(req)?.capabilities() ?? new Set<string>();
      if (op === "download")
        return caps.has("git:read") ? true : { status: 403, message: "git:read required" };
      return caps.has("git:write") || caps.has("git:write-own")
        ? true
        : { status: 403, message: "git:write required" };
    },
  });
  return withAccess({
    issuer: opts.issuer,
    rules: opts.rules ?? GIT_RULES,
    provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
  })(lfs);
}

/** git and LFS at one mount */
export function meshRepoHandler(
  repo: Repository,
  opts: MeshLfsOptions,
): (req: Request) => Promise<Response> {
  return withLfs(meshGitHandler(repo, opts), meshLfsHandler(repoLfsStore(repo), opts));
}
