/**
 * The Bridge: a loopback relay from the PeerShare page to the Sharer's local
 * Services, speaking rung 01's wire contract.
 *
 * A loopback port that answers cross-origin requests is reachable by EVERY
 * website the Sharer visits. Each rule below closes one way in; the tests in
 * `../tests/` name them.
 */

import { timingSafeEqual } from "node:crypto";
import { type FetchHandler, MARKER, urlUpstream } from "@statewalker/webrun-http-proxy";
import {
  BRIDGE_MARKER,
  BRIDGE_REDIRECT_LOCATION_HEADER,
  BRIDGE_REDIRECT_STATUS_HEADER,
  BRIDGE_TARGET_HEADER,
  BRIDGE_TOKEN_HEADER,
} from "../../01-upstream-kinds/src/upstreams.js";
import { checkTarget, isPrivateAddress } from "./targets.js";

export interface BridgeInit {
  /** The Pairing token generated at launch; nothing is answered without it. */
  token: string;
  /** The PeerShare page's origin; the only one granted cross-origin access. */
  allowedOrigin: string;
  /** Injected by tests; defaults to the platform's. */
  fetchImpl?: typeof fetch;
  /** Every address a `.local` name resolves to. Injected by tests; defaults to the OS resolver. */
  resolveHost?: (name: string) => Promise<string[]>;
}

async function systemResolve(name: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(name, { all: true })).map((a) => a.address);
}

export function createBridge(init: BridgeInit): FetchHandler {
  const resolveHost = init.resolveHost ?? systemResolve;
  return async (request) => {
    // A page on another site carries its own `Origin`. No `Origin` at all is
    // a local process (curl, the Probe's CLI): the token alone admits it.
    const origin = request.headers.get("origin");
    if (origin != null && origin !== init.allowedOrigin) return refuse(403, "origin-forbidden");

    // A preflight never carries custom headers, so it cannot carry the token:
    // the origin check above is all that guards it, and it grants nothing
    // but permission to send the real, token-bearing request.
    if (
      origin != null &&
      request.method === "OPTIONS" &&
      request.headers.has("access-control-request-method")
    ) {
      return preflight(request, origin);
    }
    if (!sameSecret(request.headers.get(BRIDGE_TOKEN_HEADER), init.token)) {
      return refuse(401, "bad-token", origin);
    }
    // No target: the page is asking whether its Bridge is there and its
    // token is right (the token check above already passed).
    const target = request.headers.get(BRIDGE_TARGET_HEADER) || null;
    if (target == null) {
      const headers = new Headers({ "content-type": "application/json" });
      if (origin != null) grantTo(headers, origin);
      return new Response(JSON.stringify({ bridge: "peershare" }), { headers });
    }
    // The page passed both checks, so it may read WHY the target was refused.
    const verdict = checkTarget(target);
    if (verdict === "forbidden") return refuse(403, "target-forbidden", origin);
    if (verdict !== "allowed") {
      const addresses = await resolveHost(verdict.resolve).catch(() => []);
      if (addresses.length === 0) return refuse(502, "target-unreachable", origin);
      if (!addresses.every(isPrivateAddress)) return refuse(403, "target-forbidden", origin);
    }

    // The same re-issuing the page itself does (rung 01): hop-by-hop headers
    // dropped, body streamed, redirects reported. The Bridge's own headers
    // are consumed by this hop.
    const upstream = urlUpstream({
      base: target,
      stripRequestHeaders: [BRIDGE_TARGET_HEADER, BRIDGE_TOKEN_HEADER],
      ...(init.fetchImpl != null ? { fetchImpl: init.fetchImpl } : {}),
    });
    const response = await upstream(request);

    // The proxy's own "unreachable" is about the SERVICE here. Passed on as
    // is, the page's upstream (to which the Bridge is the upstream) would
    // read it as "the Bridge is down" — so it is restated in the contract's
    // words, and the proxy's marker removed.
    if (response.headers.get(MARKER) === "upstream-unreachable") {
      return refuse(502, "target-unreachable", origin);
    }

    const headers = new Headers(response.headers);
    headers.set(BRIDGE_MARKER, "relayed");

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location != null) {
      headers.delete("location");
      headers.set(BRIDGE_REDIRECT_STATUS_HEADER, String(response.status));
      headers.set(BRIDGE_REDIRECT_LOCATION_HEADER, withinService(location, target));
      if (origin != null) grantTo(headers, origin);
      return new Response(null, { status: 200, headers });
    }

    if (origin != null) grantTo(headers, origin);
    return new Response(response.body, { status: response.status, headers });
  };
}

/**
 * A location on the Service itself, as a path: the Guest sees the Service at
 * the root of their own origin, so `http://127.0.0.1:5173/login` must become
 * `/login`. Anywhere else stays absolute.
 */
function withinService(location: string, target: string): string {
  const resolved = new URL(location, target);
  if (resolved.origin !== new URL(target).origin) return resolved.href;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function preflight(request: Request, origin: string): Response {
  const headers = new Headers({
    "access-control-allow-origin": origin,
    vary: "Origin",
    // Echoed: Guests' requests carry whatever headers the shared app uses.
    "access-control-allow-methods": request.headers.get("access-control-request-method") ?? "GET",
    "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "",
    "access-control-max-age": "600",
  });
  // Chromium's Private Network Access preflight: a public page asking for loopback.
  if (request.headers.get("access-control-request-private-network") === "true") {
    headers.set("access-control-allow-private-network", "true");
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Cross-origin permission for exactly one origin. Whatever the Service itself
 * sends (`*`, credentials) is replaced: the Service's CORS policy was written
 * for its own pages, not for a relay that every website can try to reach.
 */
function grantTo(headers: Headers, origin: string): void {
  for (const name of [...headers.keys()]) {
    if (name.startsWith("access-control-")) headers.delete(name);
  }
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "Origin");
  // Every response header, the marker included, readable by the page.
  headers.set("access-control-expose-headers", [...headers.keys()].join(", "));
}

/**
 * A refusal carries no CORS headers unless `grantTo` is given: a foreign page
 * cannot even read why it was refused.
 */
function refuse(status: number, reason: string, grantToOrigin?: string | null): Response {
  const headers = new Headers({ [BRIDGE_MARKER]: reason });
  if (grantToOrigin != null) grantTo(headers, grantToOrigin);
  return new Response(null, { status, headers });
}

function sameSecret(given: string | null, expected: string): boolean {
  if (given == null) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
