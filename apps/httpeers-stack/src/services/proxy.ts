/**
 * External HTTP APIs, offered to the mesh as a resource.
 *
 * NOTHING IS STRIPPED AND NOTHING ADDED beyond the route's configured headers.
 * There is no allow-list and no deny-list here, per ADR-0014: the transport
 * carries a serialized HTTP message and does not classify headers as useful or
 * useless. That is what lets a message leave the upstream, cross WebRTC, and
 * arrive at the calling page's ServiceWorker as itself.
 *
 * It is also unnecessary. The BROWSER already refuses to put `connection`,
 * `host`, `transfer-encoding`, `keep-alive`, `upgrade`, `te`, `trailer`,
 * `content-length`, `cookie`, `set-cookie` and `proxy-authorization` on a
 * `Request` -- measured, not assumed. On Node they are forwarded, which is
 * correct: undici recomputes framing, and bodies pass through untransformed so
 * a forwarded `content-length` stays accurate.
 *
 * BODIES ARE NEVER COLLECTED. No `.text()`, `.json()` or `.arrayBuffer()`
 * anywhere in this module -- a `text/event-stream` from a chat completion has
 * to reach the caller as it arrives, and this is the component in the best
 * position to accidentally destroy that.
 *
 * NO DOM AND NO `node:` IMPORTS. A Node host must be able to import this file
 * unchanged, so the same rewriting serves a server-side proxy that can reach
 * localhost and LAN addresses a browser cannot.
 */
import type { FetchHandler, RuleSet } from "@statewalker/httpeers.core";
import { Hono } from "hono";
import { appRules } from "../policy.js";
import { type ProxyRoute, matchRoute, upstreamUrl } from "./proxy-routes.js";

export interface ProxyEndpointInit {
  /** Read per request, never snapshotted, so the page can edit routes without rebuilding the endpoint. */
  routes: () => readonly ProxyRoute[];
  /** Injected by tests. Defaults to the platform's. */
  fetchImpl?: typeof fetch;
  /** Where this endpoint is mounted, stripped before matching. Defaults to `/proxy`. */
  mountPrefix?: string;
}

/** Marks the proxy's OWN responses, so they are never mistaken for an upstream's. */
const MARKER = "x-httpeers-proxy";

export function createProxyEndpoint(init: ProxyEndpointInit): FetchHandler {
  const doFetch = init.fetchImpl ?? globalThis.fetch;
  const mountPrefix = init.mountPrefix ?? "/proxy";
  const app = new Hono();

  app.all("*", async (c) => {
    const url = new URL(c.req.raw.url);
    const pathname = url.pathname.startsWith(mountPrefix)
      ? url.pathname.slice(mountPrefix.length)
      : url.pathname;

    // THE MOUNT ROOT DESCRIBES THE PROXY. A consumer discovers a provider as
    // `{ peerId, id, title }` and nothing more, so without this it could only
    // guess prefixes. It lists prefix and upstream and NOTHING about headers:
    // a header's value is a credential, and its name says which scheme is in
    // use, and every member of the mesh can read this.
    //
    // Checked before routing, and it cannot collide: no valid prefix is empty,
    // and the page refuses a bare "/". Only a read is a listing -- any other
    // method at the root falls through and misses like any unknown route.
    if ((pathname === "" || pathname === "/") && c.req.raw.method === "GET") {
      return c.json({
        routes: init.routes().map((r) => ({ prefix: r.prefix, upstream: r.upstream })),
      });
    }

    const found = matchRoute(init.routes(), pathname);
    if (found == null) {
      return c.text(`no route for ${pathname}`, 404, { [MARKER]: "no-route" });
    }

    const headers = new Headers(c.req.raw.headers);
    // THE ONE HEADER THAT IS NOT FORWARDED, and it is not a judgement about
    // usefulness. On the mesh path `authorization` carries the MESH's own
    // credential: `edge-dispatch` sets it, and `peer.ts` verified it before this
    // handler ran. It was addressed to this hop, not to the upstream -- the way
    // HTTP's `Proxy-Authorization` is consumed by the proxy it names rather than
    // passed on.
    //
    // Forwarding it did two kinds of damage, both measured. It handed a mesh
    // token to third parties (OpenAI echoed one back). And it turned every
    // request into a preflighted one, which broke any upstream whose preflight
    // does not name `authorization`: swapi answers such a preflight with no CORS
    // headers at all, and `allow-headers: *` does not cover it under the Fetch
    // spec. Upstream credentials come from the ROUTE, which is the point of the
    // proxy -- members call the upstream without holding the key.
    //
    // A caller cannot supply its own upstream `authorization` through the mesh
    // anyway: edge-dispatch never overwrites a caller's header, so one set by
    // the caller would replace the mesh token and fail verification.
    headers.delete("authorization");
    // LAST, so operator configuration wins over anything a caller sent. A
    // caller's own `authorization` therefore survives only on a route that
    // configures none -- which is the sensible reading of a route that needs
    // no credential of its own.
    for (const [name, value] of Object.entries(found.route.headers)) headers.set(name, value);

    const body = c.req.raw.body;
    const outbound = new Request(upstreamUrl(found.route, found.rest, url.search), {
      method: c.req.raw.method,
      headers,
      body,
      // Required whenever a stream is the body; both runtimes throw without it.
      ...(body != null ? { duplex: "half" as const } : {}),
      redirect: "manual",
    });

    try {
      const upstream = await doFetch(outbound);
      // The body is handed on, not read. `Response` is constructed rather than
      // returned directly because a response from `fetch` has immutable
      // headers and Hono needs to be able to hand it back.
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (err) {
      // A browser cannot tell a CORS refusal from a network failure -- `fetch`
      // rejects with an opaque TypeError for both -- so this reports what it
      // knows and does not assert which.
      const message = err instanceof Error ? err.message : String(err);
      return c.text(
        `upstream ${found.route.upstream} could not be reached: ${message}\n` +
          "If the upstream is up, it most likely does not permit cross-origin requests.",
        502,
        { [MARKER]: "upstream-unreachable" },
      );
    }
  });

  return app.fetch as FetchHandler;
}

/**
 * This provider's own policy, gating every route behind `app:proxy.use`.
 * Membership is the boundary: anyone who can reach this proxy can spend
 * whatever credential its routes are configured with.
 */
export const PROXY_POLICIES: readonly string[] = [
  // TWO CLAUSES, not one. `$r.starts_with("/proxy")` alone would also
  // authorize `/proxying` -- see `../policy.ts`'s "A PATH GOVERNS ITSELF AND
  // ITS SUBTREE, AND NOTHING ELSE". The mount itself, then its subtree.
  'allow if capability("app:proxy.use"), resource("/proxy")' +
    ' or capability("app:proxy.use"), resource($r), $r.starts_with("/proxy/");',
];

export const PROXY_RULES: RuleSet = appRules(PROXY_POLICIES);
