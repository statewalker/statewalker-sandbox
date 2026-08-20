/**
 * The one module that sits between a page's own `fetch()` and this peer's
 * `dispatch`. Everything a request needs in order to survive the crossing
 * page -> ServiceWorker -> `SwHttpAdapter` -> `peer.dispatch` lives here,
 * and nowhere else -- above all, NOT in the page.
 *
 * IT EXISTS SO THAT A PAGE IS AN ORDINARY HTTP CLIENT. The project's
 * central bet is that application code calls a mesh peer with a plain
 * `fetch()` -- no SDK, no client library. A page that had to hand-assemble
 * a bearer header on every call, strip a mount prefix, or parse an error
 * message string to tell "gone" from "refused" would have an SDK; it would
 * just be an undocumented one, reimplemented per page. This module is the
 * runtime's side of that bet.
 *
 * Kept dependency-free of libp2p AND of `@statewalker/webrun-http-browser`
 * on purpose (only `httpeers.core`, all of it pure): that is what lets
 * every rule below be proven under plain Node in `tests/browser-edge-
 * dispatch.test.ts` rather than deferred to Task 15's Playwright run.
 *
 * THREE JOBS, IN ORDER.
 *
 * 1. STRIP THE EDGE'S OWN MOUNT PREFIX. Verified directly against
 *    `@statewalker/webrun-http-browser@workspace:0.3.3`, not assumed:
 *    `SwHttpAdapter._handleHttpRequest` (`src/sw/http-sw-dispatcher.ts`)
 *    selects a handler by `requestUrl.indexOf(urlPrefix) === 0` and then
 *    calls `handler(request)` with the ORIGINAL, UNMODIFIED request. So a
 *    page fetching `${baseUrl}${peerId}/search` -- where `baseUrl` ends in
 *    `/${key}/`, and `key` must be the first path segment
 *    (`edge-guard.ts`'s `assertKeyMatchesPrefix`; `SwHttpDispatcher` keys
 *    its channel lookup on that segment, so mounting at `/` is not
 *    available) -- reaches `dispatch` with pathname
 *    `/${key}/${peerId}/search`. `httpeers.core`'s router
 *    (`router.ts`'s `route`) reads the FIRST segment and asks
 *    `looksLikePeerId`; `key` is not a peer id, so the request is served
 *    LOCALLY against a path no mount claims -- a 404 whose body says "not
 *    found", three layers away from the mistake. Stripping the prefix here
 *    is what makes the router see `/${peerId}/search`, which is the shape
 *    it documents.
 *
 * 2. ATTACH THE MEMBERSHIP TOKEN (Ruling 59). `peer.call()` turns a
 *    `{ token }` option into an `authorization: Bearer` header (`peer.ts`);
 *    `fetch()` has no such option, so without this every mesh call from a
 *    page would arrive at the provider tokenless and be refused 401. The
 *    token is NOT the page's to hold: it rotates on each 5 s heartbeat
 *    inside `startJoin`'s closure (`join.ts`), so a page that read one and
 *    kept it would be sending a stale token within seconds. `token()` is
 *    therefore called per request, never snapshotted.
 *
 * 3. TURN A THROWN `PeerCallError` INTO A RESPONSE (Ruling 60). `remote()`
 *    THROWS T-2's typed error; nothing between it and the page converts it
 *    to a Response, and `SwHttpDispatcher`'s own catch
 *    (`http-sw-dispatcher.ts`) collapses any thrown handler error into a
 *    bare 500 with no body. A page would then see one indistinguishable
 *    500 for a departed peer, a reset stream and a timeout -- precisely the
 *    "no way to tell 'this peer is gone' from 'this peer refused you'
 *    without parsing a message string" that `httpeers.core`'s `errors.ts`
 *    exists to end. The mapping below forwards `kind` in the body so the
 *    page can `switch` on it.
 *
 * WHY THE STATUS TABLE LIVES IN THE APP AND NOT IN `httpeers.core`. Same
 * split the core already uses for `allowForward` (supplied by the caller,
 * never decided in the router): a status code is policy. `errors.ts`
 * anticipated this crossing -- `kind` exists, in its own words, "so a
 * caller can `switch` on it, or forward it across a boundary that cannot
 * carry a class reference" -- but anticipating the crossing is not owning
 * the status choice.
 *
 * INBOUND REQUESTS ARE NOT TOUCHED AT ALL. The same `dispatch` also serves
 * traffic that arrived from OTHER peers over libp2p, and that traffic must
 * never be handed our token: doing so would let any peer that can reach us
 * borrow our membership for a call to a third party. The discriminant is
 * `lookupPeer(req) === undefined` -- the very same one `createPeer`'s own
 * `allowForward` uses (`peer.ts`) to tell "originated at our own edge" from
 * "arrived from the network", because libp2p's handshake always proves
 * someone for the latter. An inbound request is passed to `dispatch`
 * BYTE-IDENTICAL, with no prefix strip, no header, and no error mapping, so
 * this module cannot change how this peer behaves as a server at all.
 */
import type { FetchHandler, PeerErrorKind } from "@statewalker/httpeers.core";
import { json, lookupPeer, PeerCallError } from "@statewalker/httpeers.core";

/**
 * `PeerErrorKind` -> HTTP status, the whole table.
 *
 * A timeout is a 504 (`Gateway Timeout`) because that is literally what
 * happened: this peer, acting as the page's gateway onto the mesh, gave up
 * waiting for the peer behind it. Everything else is a 502 (`Bad Gateway`):
 * the upstream peer could not be reached, does not speak the protocol, reset
 * the stream, or blew a relay limit -- all of them "the gateway could not
 * get an answer from upstream", none of them a fault in the request the page
 * made. Deliberately never a 5xx that would blame the page's own request
 * (a 400-family status), and never a 500: a 500 here is reserved for a
 * genuine bug (see `createEdgeDispatch`'s rethrow).
 */
export const PEER_ERROR_STATUS: Readonly<Record<PeerErrorKind, number>> = {
  "request-timeout": 504,
  "peer-unreachable": 502,
  "protocol-unsupported": 502,
  "stream-reset": 502,
  "relay-limit-exceeded": 502,
  unknown: 502,
};

/** The body shape a page reads back from a failed mesh call. `kind` is the discriminant to `switch` on; `error` is for a human, never for a `switch`. */
export interface PeerErrorBody {
  error: string;
  kind: PeerErrorKind;
  peerId: string;
}

export interface EdgeDispatchInit {
  /** This peer's own router -- `peer.dispatch`. Never called with a modified request unless the request originated locally; see the module comment. */
  dispatch: FetchHandler;
  /** The ServiceWorker adapter key. Requests arriving from the page still carry `/${key}` on their path -- job 1 above. */
  key: string;
  /** This peer's current membership token, READ AT CALL TIME -- `JoinHandle.token`. */
  token: () => string;
}

/**
 * Removes a leading `/${key}` segment from `pathname`, respecting segment
 * boundaries: with `key` `"app"`, `/app/x` -> `/x` and `/app` -> `/`, but
 * `/application/x` is left alone (it is not this prefix, it merely starts
 * with the same characters -- the same trap `httpeers.core`'s own mount
 * matching documents in `router.ts`, "`/test` does NOT match `/testing`").
 *
 * Exported for its own test: this is pure string logic and there is no
 * reason to reach it only through a Request.
 */
export function stripEdgePrefix(pathname: string, key: string): string {
  const prefix = `/${key}`;
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

/**
 * Wraps `dispatch` with the three jobs above, for mounting on the
 * ServiceWorker edge (`edge.ts`'s `mountEdge`). The result is still a plain
 * `FetchHandler`, so `mountEdge` keeps passing a handler through unchanged
 * and nothing about that contract changes.
 */
export function createEdgeDispatch(init: EdgeDispatchInit): FetchHandler {
  const { dispatch, key } = init;

  return async function edgeDispatch(req: Request): Promise<Response> {
    // Arrived from the network (some peer was proven by the transport, or
    // was deliberately proven to be nobody -- either way, a binding exists).
    // Not ours to touch. See the module comment.
    if (lookupPeer(req) !== undefined) return dispatch(req);

    const url = new URL(req.url);
    url.pathname = stripEdgePrefix(url.pathname, key);
    const outbound = new Request(url, req);
    // NEVER OVERWRITE A CALLER'S OWN authorization HEADER. A page that set
    // one deliberately -- calling a peer with a token it was handed out of
    // band, or testing what a provider does with a bad one -- meant it, and
    // silently replacing it would make that call untestable and its failure
    // inexplicable.
    if (!outbound.headers.has("authorization")) {
      outbound.headers.set("authorization", `Bearer ${init.token()}`);
    }

    try {
      return await dispatch(outbound);
    } catch (err) {
      // `instanceof` ONLY, and rethrow everything else. A genuine bug in a
      // handler must still surface as `SwHttpDispatcher`'s 500 rather than
      // be dressed up as a network condition the page will politely offer
      // to retry -- the failure mode this mapping exists to prevent, turned
      // inside out.
      if (!(err instanceof PeerCallError)) throw err;
      const body: PeerErrorBody = { error: err.message, kind: err.kind, peerId: err.peerId };
      return json(body, PEER_ERROR_STATUS[err.kind]);
    }
  };
}
