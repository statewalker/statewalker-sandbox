# httpeers-lib-protos

Seventeen prototypes, each answering **one** open question of the httpeers
**library extraction** — the move from `apps/httpeers-stack` (a working demo) to
a set of isomorphic packages published from the `httpeers` monorepo.

Companion to [`httpeers-protos`](../httpeers-protos), which established the mesh
itself, and [`httpeers-shell-protos`](../httpeers-shell-protos), which
established the shell. This ladder establishes nothing about the mesh: it asks
only whether the code that already works can be **cut along the proposed seams**
and still work, on both sides of the isomorphism claim.

## Ground truth

The prototype is the specification. Every rung starts from code that already
runs in `apps/httpeers-stack` or `packages/httpeers.core` and asks what happens
when it is moved, injected into, or run on the other platform. Where a rung
finds that the proven code cannot be made isomorphic, **the proven code wins**
and the seam moves — that outcome is a result, not a failure.

The base is the union of both working branches: `main`'s mesh proxy merged with
`feat/hub-relay`'s hub-relayed signalling, reservation supervisor and page-wake.

## The questions

Rungs 01–06 cut the seams. Rungs 07–17 answer the API design, prompted by two
rounds of adversarial review in which the best findings all came from *running*
something and the worst prose survived every reading.

| | Question | Answer |
|---|---|---|
| **01-node-member** | Does the member lifecycle run headless under Node, with the in-process edge instead of the ServiceWorker? | **Yes**, on the production path with three injected adapters. `fetch` is the edge on both platforms; `baseUrl` is the browser-only part |
| **02-sw-access** | Can a Biscuit token be verified **inside** a ServiceWorker? | **Not as published** (top-level await), **yes** through the `__wbg_set_wasm` loader seam — but the architecture puts access checks in the page, so this is an option, not a requirement |
| **03-qr-pixels** | Does a pure-pixel decoder read QR codes that a camera actually produced? | jsqr **8/12**, the incumbent **9/12**, differing on heavy blur. Pure decoder for still images; the live camera loop stays in the app |
| **04-hub-storage** | Does hub state survive a restart over a FilesApi adapter, and what breaks with two writers? | **Survives**; `get`/`set`/`delete` is enough; two writers **clobber silently**, so single-writer is a precondition, not a storage feature |
| **05-expose** | Are "reverse proxy" and "expose a local service" one mechanism? | **Yes** — twelve scenarios pass on both platforms. `Via` is the one row a browser cannot do |
| **06-ghost-pin** | Can a remote peer's app render as a page that can reach **only** that peer? | **The peer pin holds**; a **root-absolute URL escapes** to the viewer's origin, and `<base href>` does not fix it |
| **07-api-types** | Can the API build the consumers a critic declared unbuildable? | **Yes, and the compiler says so.** `tsc` is the test; a negative control proves the API also *rejects* what it must |
| **08-gateway** | Can the mesh be served as ordinary HTTP? | **Yes.** `fetch("http://127.0.0.1:PORT/<peerId>/echo/hi")` returns a remote peer's response; the client knows nothing about libp2p and holds no token |
| **09-duplex** | Does the second altitude work — duplex streams over the mesh? | **Yes, including genuine full duplex.** A fetch-only contract cannot express WebSockets; this one can |
| **10-revocation** | Does a revocation reach a stream that is **already open**? | **It does now**, and the fix had to move twice: enforcement belongs on the input side, and both directions need guarding |
| **11-transports** | One site over direct calls, a MessagePort and libp2p — parity? | **24 of 24 cells green**, and Biscuit validation runs with no libp2p in the process at all |
| **12-hub-http** | Is the hub protocol nothing but HTTP? | **Yes.** The whole membership lifecycle runs over three transports with byte-identical hub and client code and two seams swapped |
| **13-teardown** | Why `close()` and not `.return()`? | **A defect in two places**, reproducible with no libp2p, fixed at the source — plus one part that is a property of the language and no library can fix |
| **14-browser-site** | Does the same site work in a browser, over a ServiceWorker? | **Yes — the fourth parity column.** Getting there uncovered four more `webrun-wire` defects, all fixed |
| **15-ports** | Can a libp2p connection hand out MessagePorts? | **Yes — one stream is one port**, and webrun-rpc's stack runs over it unmodified. The dividing line for "isomorphic" turns out to be **transfer**, which `tsc` cannot see |
| **16-ghost-containment** | Which ghost containment actually contains? | **A path-scoped CSP**, at no cost to the host app. The sandboxed-iframe candidate is **disqualified**: its opaque origin removes the document from the ServiceWorker's control |
| **17-port-factory** | Can one consumer run over every kind of port? | **Yes, in twenty lines.** Take a SOURCE of ports, not a port: `multiplexPort` where the transport is one pipe, a libp2p stream per port where yamux already multiplexes. The second multiplexer disappears |

One hundred and six claims, all passing, ~55 s: `pnpm test`.

## What came out that no rung asked for

Nine defects in `webrun-wire` itself, all fixed at the source in a sibling
worktree with regression tests **in the package**, not in this ladder:

- **Teardown that never reached the producer** (rungs 09, 10, 13).
  `duplexOverStream` awaited a `.return()` that is queued behind a pending
  `next()`, so it hung for ever; `emulateMux`'s outbound pump checked `closed`
  only *after* a chunk arrived, so it leaked. Both now acquire the iterator
  once and cancel without awaiting. Two documented hazards became features.
- **Cancellation that stopped at the adapter** (rung 14). `toReadableStream`
  had no `cancel` and drained its whole source in one `pull`;
  `fromReadableStream` never released its reader. Between them they broke every
  abort path in the repo.
- **A transport with no cancellation message** (rung 14). Closing a
  `MessagePort` does not notify its peer, so a browser handler kept producing
  for the life of the page after its caller had gone.
- **A worker url that could not be relative** (rung 14). `new
  URL("/sw-worker.js")` with no base throws from a *constructor*, naming
  neither the option nor the value.
- **A port stack that only accepted `MessagePort`** (rung 15). `PortParams` and
  `byteChannelFromMessagePort` were narrowed though neither needs more than
  `MessageTarget`, which shut out every virtual port — including the one a mesh
  hands out. Found by `tsc`.

And in the httpeers code itself:

- **`sideEffects: false` + `rollupOptions` silently produces a dead
  ServiceWorker** — it registers, activates, and intercepts nothing. Rung 02
  hit the trap `apps/httpeers-stack/vite.app.config.ts` already records from
  its Task 12. Any extracted package with a worker entry needs the same note,
  and the check has to be *does it control the page*, not *does it register*.
- **Two shipping proxy defects**: a redirecting upstream is reported as
  `502 upstream-unreachable`, and the outbound request carries no `signal`.
  Both are fixed and pinned in rung 05.
- **The Node file snapshot store is not crash-safe** (writes in place); the
  rung-04 adapter writes-then-moves.
- **Unredeemed invitations do not survive a hub restart** — they are
  memory-only. Confirmed a defect; the extracted hub persists them.
- **`looksLikePeerId` now exists in three copies** (core's router,
  edge-dispatch, and the ghost pin). The extracted core should export it once.

## A rule this ladder earned

**A hazard is not a finding until you have proved it is not a platform limit.**
Rung 13 nearly recorded "`.return()` cannot unwind a parked producer" as a
library defect; it is a property of the language, and the honest claim is the
one that says so. Rung 14 nearly recorded "a ServiceWorker cannot learn about
an abort" as a platform limit; it is not, and a forty-line probe using none of
the library's own code is what settled it. Both claims are kept in their
original form with the measurement beside them.

And its corollary, earned by rungs 15 and 16: **a mode that never reports is a
result, not an error.** Rung 16's most important finding — that a sandboxed
ghost is never served at all — would have been thrown as a timeout by the
harness that was supposed to measure it.

## Conventions

Each rung is a folder: `README.md` states the question, the claims established,
what would falsify each, and what the rung deliberately does not cover;
`tests/` holds the evidence; `src/` holds the rung's own code where it has any.
A claim with no test is not a claim. A claim that turns out to be wrong is
**rewritten with its history**, not deleted — rungs 09, 10 and 14 all carry a
claim that used to assert the opposite.

ServiceWorker rungs (02, 06, 14, 16) use
[`@statewalker/webrun-http-browser`](https://github.com/statewalker/webrun-wire/tree/main/packages/webrun-http-browser)
and [`webrun-site-host`](https://github.com/statewalker/webrun-wire/tree/main/packages/webrun-site-host)
— `SwHttpAdapter` / `HostedSiteBuilder` on the page side, `startHttpDispatcher`
in the worker. No hand-written ServiceWorker plumbing.

Unpublished `webrun-wire` packages are consumed with `link:` from a sibling
worktree. **They export `dist/`, so a source fix that is not rebuilt does
nothing** — rebuild before concluding a fix failed.

```bash
pnpm test              # every rung
pnpm test 01-node-member
pnpm typecheck
```
