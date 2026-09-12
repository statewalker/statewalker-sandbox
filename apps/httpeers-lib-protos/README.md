# httpeers-lib-protos

Six prototypes, each answering **one** open question of the httpeers **library
extraction** — the move from `apps/httpeers-stack` (a working demo) to a set of
isomorphic packages published from the `httpeers` monorepo.

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

| | Question | Answer |
|---|---|---|
| **01-node-member** | Does the member lifecycle run headless under Node, with the in-process edge instead of the ServiceWorker? | **Yes**, on the production path with three injected adapters. `fetch` is the edge on both platforms; `baseUrl` is the browser-only part |
| **02-sw-access** | Can a Biscuit token be verified **inside** a ServiceWorker? | **Not as published** (top-level await), **yes** through the `__wbg_set_wasm` loader seam — but the architecture puts access checks in the page, so this is an option, not a requirement |
| **03-qr-pixels** | Does a pure-pixel decoder read QR codes that a camera actually produced? | jsqr **8/12**, the incumbent **9/12**, differing on heavy blur. Pure decoder for still images; the live camera loop stays in the app |
| **04-hub-storage** | Does hub state survive a restart over a FilesApi adapter, and what breaks with two writers? | **Survives**; `get`/`set`/`delete` is enough; two writers **clobber silently**, so single-writer is a precondition, not a storage feature |
| **05-expose** | Are "reverse proxy" and "expose a local service" one mechanism? | **Yes** — twelve scenarios pass on both platforms. `Via` is the one row a browser cannot do |
| **06-ghost-pin** | Can a remote peer's app render as a page that can reach **only** that peer? | **The peer pin holds**; a **root-absolute URL escapes** to the viewer's origin, and `<base href>` does not fix it |

Thirty claims, all passing, ~17 s: `pnpm test`.

## What came out that no rung asked for

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
- **Unredeemed invitations do not survive a hub restart** — they are memory-only.
- **`looksLikePeerId` now exists in three copies** (core's router,
  edge-dispatch, and the ghost pin). The extracted core should export it once.

## Conventions

Each rung is a folder: `README.md` states the question, the claims established,
what would falsify each, and what the rung deliberately does not cover;
`tests/` holds the evidence; `src/` holds the rung's own code where it has any.
A claim with no test is not a claim.

ServiceWorker rungs (02, 06) use
[`@statewalker/webrun-http-browser`](https://github.com/statewalker/webrun-wire/tree/main/packages/webrun-http-browser)
— `SwHttpAdapter` on the page side, `startHttpDispatcher` in the worker. No
hand-written ServiceWorker plumbing.

```bash
pnpm test              # every rung
pnpm test 01-node-member
pnpm typecheck
```
