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

| | Question | Answer decides |
|---|---|---|
| **01-node-member** | Does the member lifecycle run headless under Node, with the in-process edge instead of the ServiceWorker? | Whether `member` is one isomorphic package or two platform ones |
| **02-sw-access** | Can a Biscuit token be verified **inside** a ServiceWorker? | Whether `withAccess` may run at the edge, or only in the page |
| **03-qr-pixels** | Does a pure-pixel decoder read QR codes that a camera actually produced? | Whether the isomorphic decoder is *the* decoder or a server-side one |
| **04-hub-storage** | Does hub state survive a restart over a FilesApi adapter, and what breaks with two writers? | Whether the storage interface needs a conditional write |
| **05-expose** | Are "reverse proxy" and "expose a local service" one mechanism? | Whether `expose` is one package or two |
| **06-ghost-pin** | Can a remote peer's app render as a page that can reach **only** that peer? | Whether the ghost's isolation claim holds at all |

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
