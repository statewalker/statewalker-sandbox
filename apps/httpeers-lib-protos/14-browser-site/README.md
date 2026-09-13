# 14 — The same site in a browser, over a ServiceWorker

`pnpm test 14-browser-site`

**Answer: the fourth parity column is green, and getting it there uncovered
four defects in `webrun-wire` — all four fixed at the source, with tests.**

Rung 11 served one site over direct calls, a `MessagePort` and libp2p. This
rung serves *that same site*, unchanged, through
`@statewalker/webrun-site-host`'s `HostedSiteBuilder` in a real Chromium —
the composition path the directive names for the browser. The scenarios come
from `11-transports/src/scenarios.ts` by import, so this column is produced by
the same assertions as the other three and cannot quietly diverge from them.

## Verified

| # | Claim | What would falsify it |
|---|---|---|
| 1 | The site is published and reachable at its own base URL | no `/mesh/` base URL |
| 2 | **All eight rung-11 scenarios pass in the browser** | any scenario failing — the row names which |
| 3 | Biscuit validation works in a page with no libp2p present | `/secret` not answering 200 for a valid token |
| 4 | An aborted request **unwinds the handler**, in the browser too | the producer advancing after the caller has gone |
| 5 | The abort **is** observable to a ServiceWorker | neither `request.signal` nor the stream's `cancel` firing |

Measured 2026-09-12, all five pass.

```
✓ GET /hello → 200                  ✓ GET /secret without a token → 401
✓ POST /echo round-trips a body     ✓ GET /secret with a valid token → 200
✓ POST /echo survives 256 KiB       ✓ GET /secret with a foreign token → 403
✓ a query string is not lost        ✓ GET /nothing-here → 404
```

## Claim 4 was a HAZARD when this rung was built

As first measured, an aborted `fetch` stopped at the caller: the handler's
producer kept producing for the life of the page, where Node's gateway
propagates the abort into the handler (rung 08 claim 7). The deprecation
notice on `handleHttpRequests`/`sendHttpRequest` predicted as much — "no
backpressure, no chunking, no per-stream timeout" — and it would have been
easy to write that down as a documented limitation of the browser rung.

**Claim 5 is why that would have been wrong.** Rung 13 had to separate a
library defect from a limit of the language; this is the browser's version of
the same question, and it had to be *measured*:

```
What the worker saw on abort: {"signal":false,"cancel":true,"ticks":3,"ended":true}
```

`event.request.signal` never fires in Chromium — the obvious channel is
unavailable — but the `ReadableStream` handed to `respondWith` **is**
cancelled, and the worker's own producer stopped at 3 ticks. So the browser
does tell the worker. The leak was ours.

`probe-worker.ts` deliberately uses no `webrun-http-browser` code at all: a
defect in the transport must not be able to mask the platform's answer. It
runs under its own scope (`/probe-app/`) because two workers claiming `/`
replace one another, which would make the rung order-dependent.

## Four defects, fixed in the sibling `webrun-wire` worktree

Three of them were in a row, each hiding the next — the abort could not reach
the handler until all three were fixed:

1. **`toReadableStream` had no `cancel`** (`webrun-streams`). A cancelled
   response body never released the iterator feeding it. Its `pull` also
   drained the *whole* iterator in one call, which defeated the stream's own
   backpressure and left no point between chunks at which a cancellation could
   take effect; it now yields one chunk per pull.
2. **`fromReadableStream` never released its reader** (`webrun-streams`).
   Returning the generator — `break`, `.return()`, an error — left the source
   stream uncancelled and its producer running. It now cancels on early exit
   and merely releases on a natural end, so a completed response is not
   mistaken for an abort.
3. **The SW transport had no cancellation MESSAGE** (`webrun-http-browser`).
   Closing a `MessagePort` does not notify its peer, so `sendStream`'s
   teardown was invisible on the far side. It now sends one, and the receiving
   channel releases what it is sending — without awaiting, because
   `.return()` on a parked generator is queued behind its pending `next()`.

And one that stopped this rung before it started:

4. **`SwPortHandler` could not accept a root-relative `serviceWorkerUrl`.**
   `new URL("/sw-worker.js")` with no base throws `Invalid URL` — from the
   *constructor*, via the `scope` getter, naming neither the option nor the
   value. A worker url is relative to the document that registers it, so it is
   now resolved against `location.href`, and an unresolvable one is reported
   with the option name.

Regression tests live with the code: `readable-streams-cancel.test.ts`,
`http-cancel.test.ts`, `sw-worker-url.test.ts`. `http-cancel.test.ts` is worth
noting — it reproduces the browser leak with **two plain `MessagePort`s and no
ServiceWorker**, so the defect is pinned where it can be run in milliseconds.

## What this costs, and what it does not

- **Latency, not leakage.** The handler stops about two producer ticks after
  the abort. A cancellation cannot land until the pending `next()` it is
  queued behind resolves (rung 13's language limit), and here that is the
  producer's own next tick. Claim 4 bounds it rather than pretending it is
  instant.
- **Biscuit runs in the PAGE, not the worker.** `HostedSiteBuilder` registers
  the handler from the page and the worker only dispatches, so rung 02's
  wasm-in-a-worker seam is not needed here. Claim 3 holds because pages allow
  top-level await.

## Not covered

- **Chromium only.** Firefox's request-streams gap (see `http-stubs.ts`) would
  buffer the 256 KiB body rather than stream it; claim 2 would still pass and
  would mean something weaker.
- **The backpressure half of the deprecation notice is still true.**
  `sendStream`'s chunk sender still discards the promise it is given, so a fast
  producer over a slow consumer still accumulates. Cancellation is fixed;
  backpressure is not, and the modern path (`webrun-rpc` ports +
  `httpServe`/`httpFetch`) remains the answer for that.
- **No cross-origin relay.** Same-origin only; the relay path
  (`relay-sw.js`) is untouched here.
