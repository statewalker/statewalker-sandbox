/**
 * X8c — git on an httpeers peer: X8a/X8b's `gitHandler` behind httpeers' access middleware.
 *
 * `withAccess` verifies the membership token (`x-httpeers-token`: issuer, binding to the peer the
 * transport proved, expiry) and derives capabilities from its roles. Then, per request:
 *  - upload-pack (fetch, clone) needs `git:read`;
 *  - receive-pack (push) needs `git:write` (any ref) or `git:write-own`, which an `update` hook
 *    limits to the caller's namespace `refs/peers/<peerId>/*` (git's ng "hook declined: not
 *    allowed …" for any other ref).
 * Default roles: reader (read), member (read, own namespace), maintainer (read, write). The
 * receive-pack answer's head is sent before the pack is read (X8b), so the bridge's 30 s bound on
 * a call's head does not cut a long push.
 */
import { access, ruleSet, withAccess } from "@statewalker/httpeers-access";
import { ANONYMOUS, lookupPeer, MESH_TOKEN_HEADER } from "@statewalker/httpeers-core";
import type { Repository } from "../../17-repository/src/object-store.js";
import { uploadPackHandler } from "../../21-smart-http/src/server.js";
import { receivePackHandler } from "../../22-receive-pack/src/server.js";

export interface MeshGitOptions {
  /** the mesh's issuer (the hub's peerId) */
  issuer: string;
  /** roles → capabilities and the policy (default: GIT_RULES) */
  rules?: ReturnType<typeof ruleSet>;
}

/** reader, member and maintainer; any git capability passes the policy, the handler refines it */
export const GIT_RULES = ruleSet({
  version: 1,
  rules: [
    'capability("git:read") <- role("reader");',
    'capability("git:read") <- role("member");',
    'capability("git:write-own") <- role("member");',
    'capability("git:read") <- role("maintainer");',
    'capability("git:write") <- role("maintainer");',
  ],
  policies: [
    'allow if capability("git:read");',
    'allow if capability("git:write");',
    'allow if capability("git:write-own");',
  ],
});

const forbidden = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

export function meshGitHandler(
  repo: Repository,
  opts: MeshGitOptions,
): (req: Request) => Promise<Response> {
  const upload = uploadPackHandler(repo);
  return withAccess({
    issuer: opts.issuer,
    rules: opts.rules ?? GIT_RULES,
    provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
  })(async (req) => {
    const ctx = access(req);
    const caps = ctx?.capabilities() ?? new Set<string>();
    const peer = String(ctx?.peer ?? "");
    const url = new URL(req.url);
    const isReceive =
      url.pathname.endsWith("/git-receive-pack") ||
      (url.pathname.endsWith("/info/refs") &&
        url.searchParams.get("service") === "git-receive-pack");
    if (!isReceive) {
      if (!caps.has("git:read")) return forbidden("git:read required");
      return upload(req);
    }
    if (caps.has("git:write")) return receivePackHandler(repo)(req);
    if (!caps.has("git:write-own")) return forbidden("git:write required");
    const own = `refs/peers/${peer}/`;
    return receivePackHandler(repo, {
      update: async (c) =>
        c.ref.startsWith(own) ? undefined : `not allowed: this peer writes ${own}* only`,
    })(req);
  });
}

/** A fetch that calls `peer` through a remote (createRemoteOverLink) with a membership token. */
export function meshFetch(
  call: (peer: string, req: Request) => Promise<Response>,
  peer: string,
  token: string,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const base = new Request(input, { ...init, duplex: "half" } as RequestInit);
    const headers = new Headers(base.headers);
    headers.set(MESH_TOKEN_HEADER, token);
    return call(peer, new Request(base, { headers, duplex: "half" } as RequestInit));
  }) as typeof fetch;
}
