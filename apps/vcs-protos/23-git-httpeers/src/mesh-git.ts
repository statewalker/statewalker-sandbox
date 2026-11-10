/**
 * X8c — git on an httpeers peer: X8a/X8b's upload-pack and receive-pack behind httpeers' access
 * middleware.
 *
 * `withAccess` verifies the membership token (`x-httpeers-token`: issuer, binding to the peer the
 * transport proved, expiry) and derives capabilities from its roles. Then, per request:
 *  - upload-pack (fetch, clone) needs `git:read`;
 *  - receive-pack (push) needs `git:write` (any ref) or `git:write-own`, which limits the push to
 *    the caller's namespace `refs/peers/<peerId>/*` — checked on the commands before the pack is
 *    read (a push outside it stores nothing) and again per ref (`ng … not allowed …`).
 * Roles are httpeers' mesh roles (see `gitRules`): admin writes, member and hidden read; members
 * push into their own namespace only when the serving peer opts in. receive-pack's response head
 * is sent before the pack is read (X8b), so the bridge's 30 s bound on a call's head does not cut a
 * long push.
 */
import { access, ruleSet, withAccess } from "@statewalker/httpeers-access";
import { ANONYMOUS, lookupPeer, MESH_TOKEN_HEADER } from "@statewalker/httpeers-core";
import { checkRefFormat } from "../../10-ref-transactions/src/refname.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { uploadPackHandler } from "../../21-smart-http/src/server.js";
import { receivePackHandler } from "../../22-receive-pack/src/server.js";

export interface MeshGitOptions {
  /** the mesh's issuer (the hub's peerId) */
  issuer: string;
  /** roles → capabilities and the policy (default: GIT_RULES, reads for all, writes for admins) */
  rules?: ReturnType<typeof ruleSet>;
}

/**
 * git's capabilities from httpeers' mesh roles, as a standard hub issues them (its join flow mints
 * `member`; `admin` and `hidden` are the others): admin → read and write; member and hidden →
 * read. With `contributors`, members may also push into their own namespace
 * (`refs/peers/<peerId>/*`) — opt-in, because every peer that joined the mesh is a member. Roles
 * are mesh-wide: the rules a serving peer chooses are its repository's policy.
 */
export function gitRules(o: { contributors?: boolean } = {}) {
  return ruleSet({
    version: 1,
    rules: [
      'capability("git:read") <- role("member");',
      'capability("git:read") <- role("hidden");',
      'capability("git:read") <- role("admin");',
      'capability("git:write") <- role("admin");',
      ...(o.contributors ? ['capability("git:write-own") <- role("member");'] : []),
    ],
    policies: [
      'allow if capability("git:read");',
      'allow if capability("git:write");',
      ...(o.contributors ? ['allow if capability("git:write-own");'] : []),
    ],
  });
}

/** The default: reads for every mesh role, writes for admins. */
export const GIT_RULES = gitRules();

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
    // a proven id that cannot be one ref-name component cannot name a namespace of its own
    if (!peer || peer.includes("/") || !checkRefFormat(`refs/peers/${peer}/x`))
      return forbidden("this peer id cannot name a ref namespace");
    const own = `refs/peers/${peer}/`;
    const outside = (ref: string) =>
      ref.startsWith(own) ? undefined : `not allowed: this peer writes ${own}* only`;
    return receivePackHandler(repo, {
      // before the pack is read: a push outside the namespace stores nothing
      authorize: async (commands) => commands.map((c) => outside(c.ref)),
      update: async (c) => outside(c.ref),
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
