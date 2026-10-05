# httpeers-lib-protos

## What it is

Sixteen prototypes, each answering **one** question about splitting the httpeers
code in `apps/httpeers-stack` and `packages/httpeers.core` into isomorphic
packages: can it be cut along the proposed seams and still work, in Node and in
the browser? Each rung is a test suite.

## Why the working code wins

Every rung starts from code that already runs in `apps/httpeers-stack` or
`packages/httpeers.core` and asks what happens when it is moved, injected into,
or run on the other platform. Where the working code cannot be made isomorphic,
the working code wins and the seam moves; that outcome is a result, not a
failure.

## Reference: the questions

| | Question | Answer |
|---|---|---|
| **01-node-member** | Does the member lifecycle run headless under Node, with the in-process edge instead of the ServiceWorker? | **Yes**, on the production path with three injected adapters. `fetch` is the edge on both platforms; `baseUrl` is the browser-only part |
| **02-sw-access** | Can a Biscuit token be verified **inside** a ServiceWorker? | Access checks run in the page, so verifying inside the worker is an option, not a requirement |
| **03-qr-pixels** | Does a pure-pixel decoder read QR codes that a camera actually produced? | jsqr **8/12**, the incumbent **9/12**, differing on heavy blur. Pure decoder for still images; the live camera loop stays in the app |
| **04-hub-storage** | Does hub state survive a restart over a FilesApi adapter, and what breaks with two writers? | **Survives**; `get`/`set`/`delete` is enough; two writers **clobber silently**, so single-writer is a precondition, not a storage feature |
| **05-expose** | Are "reverse proxy" and "expose a local service" one mechanism? | **Yes** — twelve scenarios pass on both platforms. `Via` is the one row a browser cannot do |
| **06-ghost-pin** | Can a remote peer's app render as a page that can reach **only** that peer? | **The peer pin holds**; a **root-absolute URL escapes** to the viewer's origin, and `<base href>` does not fix it |
| **07-api-types** | Can the API build the consumers it must support? | **Yes, and the compiler says so.** `tsc` is the test; a negative control proves the API also *rejects* what it must |
| **08-gateway** | Can the mesh be served as ordinary HTTP? | **Yes.** `fetch("http://127.0.0.1:PORT/<peerId>/echo/hi")` returns a remote peer's response; the client knows nothing about libp2p and holds no token |
| **09-duplex** | Does the second altitude work — duplex streams over the mesh? | **Yes, including genuine full duplex.** A fetch-only contract cannot express WebSockets; this one can |
| **10-revocation** | Does a revocation reach a stream that is **already open**? | **Yes.** Enforcement belongs on the input side, and both directions need guarding |
| **11-transports** | One site over direct calls, a MessagePort and libp2p — parity? | **24 of 24 cells green**, and Biscuit validation runs with no libp2p in the process at all |
| **12-hub-http** | Is the hub protocol nothing but HTTP? | **Yes.** The whole membership lifecycle runs over three transports with byte-identical hub and client code and two seams swapped |
| **13-teardown** | Why `close()` and not `.return()`? | `close()` reaches a producer parked in `next()`; `.return()` is queued behind it. That part is a property of the language, not of any library |
| **14-browser-site** | Does the same site work in a browser, over a ServiceWorker? | **Yes — the fourth parity column** |
| **15-ports** | Can a libp2p connection hand out MessagePorts? | **One stream is one port**, and the webrun-rpc stack runs over it. The dividing line for "isomorphic" is **transfer**, which `tsc` cannot see |
| **16-ghost-containment** | Which ghost containment actually contains? | **A path-scoped CSP**, at no cost to the host app. The sandboxed-iframe candidate is **disqualified**: its opaque origin removes the document from the ServiceWorker's control |

## What will surprise you

- **The app does not typecheck, and `pnpm test` stops there.** Rungs 11, 12, 13
  and 15 pass `{ port }` to `@statewalker/webrun-rpc`'s port `connect`/`serve`,
  whose `PortParams` has no `port` field:
  `error TS2353: Object literal may only specify known properties, and 'port' does not exist in type 'PortParams'.`
  Those rungs also fail when run with vitest alone. CI skips this app's
  `typecheck` and `test`.
- **`sideEffects: false` with `rollupOptions` produces a dead ServiceWorker**: it
  registers, activates, and intercepts nothing. The check that matters is *does
  it control the page*, not *does it register*.
- **A hazard is not a finding until it is shown not to be a platform limit.**
  Rung 13's `.return()` behaviour is a property of the language; rung 14 shows
  that a ServiceWorker *can* learn about an abort, with a probe that uses none of
  the library's code.
- **A mode that never reports is a result, not an error.** In rung 16 a
  sandboxed ghost is never served at all; a harness that treats silence as a
  timeout would hide that.
- **`looksLikePeerId` exists in three copies**: `packages/httpeers.core/src/router.ts`,
  `apps/httpeers-stack/src/browser/edge-dispatch.ts`, and rung 06's `src/ghost.ts`.

## Layout

Each rung is a folder: `README.md` states the question, the claims established,
what would falsify each, and what the rung deliberately does not cover;
`tests/` holds the evidence; `src/` holds the rung's own code where it has any.
A claim with no test is not a claim.

ServiceWorker rungs (02, 06, 14, 16) use
`@statewalker/webrun-http-browser`
and `@statewalker/webrun-site-host`
— `SwHttpAdapter` / `HostedSiteBuilder` on the page side, `startHttpDispatcher`
in the worker. No hand-written ServiceWorker plumbing.

The `webrun-*` packages come from npm through the workspace catalog
(`pnpm-workspace.yaml`).

## How to run it

From this folder, after `pnpm install` at the repo root (see *What will surprise
you* for the current typecheck failure):

```bash
pnpm test              # typecheck, then every rung (~50 s)
pnpm test 01-node-member
pnpm typecheck
```
