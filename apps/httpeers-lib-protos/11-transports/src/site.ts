/**
 * 11 — ONE site, built once, served over three transports.
 *
 * The directive: every peer exposes an HTTP `FetchHandler`; hub, membership
 * and access are plain HTTP handlers with fetch clients; libp2p is an adapter
 * detail. The test ladder that follows from it is direct → MessagePort → P2P,
 * and the whole point is that the SITE does not change between the rungs.
 *
 * So this file is the only place a request is answered, and it is written with
 * `@statewalker/webrun-site-builder` — the composition path the directive
 * names — from the worktree, unpublished, linked in.
 *
 * ACCESS IS CHECKED HERE, WITH NO LIBP2P. `/secret` verifies a Biscuit token
 * out of the `Authorization` header. Rungs 1 and 2 have no libp2p in the
 * process at all, so the fact that they pass is the evidence for "the full
 * validation works without libp2p involvement" — it is not an argument, it is
 * two rungs that could not run otherwise.
 */

import { verifyToken } from "@statewalker/httpeers.core/tokens";
import { ANONYMOUS } from "@statewalker/httpeers.core/types";
import { SiteBuilder } from "@statewalker/webrun-site-builder";

export interface SiteInit {
  /** The mesh (hub peerId) this site verifies tokens against. */
  issuer: string;
  /** This peer's own id, asserted as `self_peer` — never read from a token. */
  selfPeer: string;
  /**
   * Who the transport proved is calling, or `undefined` where the transport
   * cannot prove anything (rungs 1 and 2). Supplied per request by the
   * adapter; a CLAIM on direct/port transports, a PROOF on libp2p.
   */
  callerOf?: (request: Request) => string | undefined;
}

/** The site every rung serves. No transport imports, no platform imports. */
export function createSite(init: SiteInit) {
  const site = new SiteBuilder();

  site.setEndpoint("/hello", async () => new Response("hello from the mesh"));

  site.setEndpoint("/echo", "POST", async (request: Request) => {
    // Streamed straight back, so a rung that buffers is visible as a timing
    // difference rather than a wrong answer.
    return new Response(request.body, {
      headers: {
        "content-type": request.headers.get("content-type") ?? "application/octet-stream",
      },
    });
  });

  site.setEndpoint("/secret", async (request: Request) => {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token === "") return new Response("no token", { status: 401 });

    try {
      const claims = await verifyToken(token, {
        issuer: init.issuer,
        // The binding is exactly as strong as this seam: a proven peer on
        // libp2p, a claim elsewhere. `ANONYMOUS` when nothing is known, which
        // fails the token's own `bound`/`connection_peer` check.
        connectionPeer: init.callerOf?.(request) ?? ANONYMOUS,
        selfPeer: init.selfPeer,
      });
      return Response.json({ sub: claims.sub, roles: claims.roles });
    } catch (error) {
      return new Response(`refused: ${(error as Error).message}`, { status: 403 });
    }
  });

  return site.build();
}
