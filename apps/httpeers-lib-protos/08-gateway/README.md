# 08 — Can the mesh be served as ordinary HTTP?

`pnpm test 08-gateway`

**Answer: yes. `fetch("http://127.0.0.1:PORT/<peerId>/echo/hi")` returns a
remote peer's response in 157 ms, and the client knows nothing about libp2p,
holds no token, and has no peer object.**

Everything behind the port is real: the relay and hub processes booted from
their own entry points (`tests/e2e/harness.ts`), real Noise handshakes, and
member peers built by rung 01's production join path. The server is
`@hono/node-server` handed the gateway handler and nothing else — which is the
claim that a fetch handler really is all a host needs.

## Verified

| # | Claim | Result |
|---|---|---|
| 1 | A plain fetch to a plain port reaches a peer across the mesh | 200, `provider:/echo/hi?q=1` — the provider saw **its own** mount path, not the gateway's URL |
| 2 | The client holds no token, no peer object, no libp2p | The membership token is attached inside the edge, per call, and never reaches the HTTP client |
| 3 | The listing enumerates peers and **kinds**, never URLs | `ready`, `version`, `peers[]`, `offers[]`; the body contains no `http` |
| 4 | A peer that joins **after** the server started is dispatchable | Reachable in 1.26 s, no rebuild, no restart |
| 5 | An unknown peer is a structured mesh error, not a crash | 502/504 from the edge's taxonomy; the server keeps serving |
| 6 | A path with no peer is refused by the gateway itself | 404 with `x-httpeers-gateway: no-peer` |
| 7 | A client hang-up aborts the call rather than orphaning it | The abort propagates; the next request succeeds |

Measured 2026-09-12, all seven pass.

## What is actually new here

Almost nothing, and that is the point. The gateway **rewrites a request and
hands it to the proven edge dispatch** (`src/browser/edge-dispatch.ts`), which
already does the four things that each took a bug to discover: strip the mount
prefix, attach the token at call time, ensure a route before the call rides it,
and map a thrown `PeerCallError` onto a readable status. Three things are new:

1. **`basePath` is a parameter.** A ServiceWorker is keyed to `/{key}/` and
   *cannot* mount at `/`; a Node server mounts wherever it likes. This rung
   mounts at the root, which is the case the browser cannot express.
2. **A listing that refuses to invent URLs.** The mesh view carries peers and
   advertised kinds — no service paths. That `id` happens to equal the mount
   prefix for all three providers today is convention, not contract, so the
   listing reports kinds and lets the caller ask.
3. **Dispatch is read per request** from the live view, so claim 4 needs no
   rebuild, no cache invalidation and no restart.

## Two details that would have been bugs

- **`serve()` binds asynchronously.** `server.address()` straight afterwards is
  `null`; the listening callback is the only correct source of the port. The
  first run of this rung failed exactly there.
- **The caller's `AbortSignal` is forwarded into the mesh call.**
  `@hono/node-server` aborts it when the client hangs up, and nothing else
  would stop the libp2p stream — it would run to completion with nobody to
  receive it (claim 7).

## Not covered

- **The browser's two hosting modes.** Same-origin (ServiceWorker) and
  cross-origin (relay) are not exercised here. The research grounding them
  found an asymmetry that no amount of API design removes: a ServiceWorker only
  intercepts requests from the clients it controls, so **cross-origin mode
  cannot give the calling page a fetchable URL** — it gives a `call()` over a
  port, and a URL only to content loaded *from* the relay origin.
- **Streaming semantics are not uniform across hosts.** Node has backpressure
  and abort; the ServiceWorker bridge in `webrun-http-browser` has neither and
  says so in its own deprecation notes.
- **No `GET /` freshness guarantee.** The view is ~5 s stale by heartbeat and up
  to ~20 s for a departed peer (15 s presence TTL). The listing reports
  `version` and `asOf` so a caller can judge; it does not promise currency.
- **Authorisation is the provider's**, not the gateway's: the gateway attaches
  the caller's own membership token and the remote peer's policy decides. A
  gateway is not a way to reach mounts you could not otherwise reach.
