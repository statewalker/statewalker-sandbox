# 11 — One site, three transports: direct, MessagePort, libp2p

`pnpm test 11-transports`

**Answer: full parity. 24 of 24 scenario cells green, and Biscuit validation
runs with no libp2p in the process at all.**

This is the ladder the requirements document prescribes — *"test the full HTTP
tunnelling part over standard message channels/ports and after that check the
P2P connection part"* — built so the diff is the evidence.

## What is held constant, and what is swapped

One site (`src/site.ts`), built with `@statewalker/webrun-site-builder`, and
one scenario list (`src/scenarios.ts`). Neither can see which transport it is
on, so any row that differs is the transport's fault and nothing else.

| Rung | Wiring | Swapped |
|---|---|---|
| 1 direct | `serveFetchOverDuplex(site)` ⇄ `fetchOverDuplex(duplex, req)` | nothing — no transport exists |
| 2 MessagePort | `serve({port: ch.port2}, …)` + `connect({port: ch.port1})` | the `Duplex` only |
| 3 libp2p | `serveConnections({node, protocol}, …)` + `connect({node, peer})` | the `Connect`/`Serve` pair only |

## Measured, 2026-09-12

| Scenario | direct | port | libp2p |
|---|:--:|:--:|:--:|
| `GET /hello` → 200 | ✓ | ✓ | ✓ |
| `POST /echo` round-trips a body | ✓ | ✓ | ✓ |
| `POST /echo` survives 256 KiB | ✓ | ✓ | ✓ |
| `GET /secret` without a token → 401 | ✓ | ✓ | ✓ |
| **`GET /secret` with a valid token → 200** | ✓ | ✓ | ✓ |
| `GET /secret` with a foreign mesh's token → 403 | ✓ | ✓ | ✓ |
| `GET /nothing-here` → 404 | ✓ | ✓ | ✓ |
| a query string is not lost | ✓ | ✓ | ✓ |

Plus two claims about the ladder itself: the three transports agree row for
row, and only libp2p can *prove* who called.

## The two findings that matter

**1. Access validation needs no libp2p — and this is proof, not an argument.**
`/secret` verifies a real Biscuit token out of an `Authorization` header.
Rungs 1 and 2 have no libp2p in the call path at all, so those rows could not
be green otherwise. The directive's requirement — *"the full validation should
work without libp2p involvement"* — is met by construction.

**2. Identity is a proof on exactly one rung, and a claim on the other two.**
`serveConnections` hands the serving side `context.remotePeer`, established by
the Noise handshake, once per inbound stream. Rungs 1 and 2 have nothing to
prove anything with, so they pass a claim. Both are useful and they are not
interchangeable:

> Rungs 1–2 prove the **Datalog** — policies, roles, expiry, foreign-mesh
> rejection. Only rung 3 can prove the **binding**, i.e. that a token is not
> replayable by whoever holds it.

An API that blurs those two would be lying about what it enforces, which is
why `callerOf` is an explicit per-request seam in `site.ts` rather than an
ambient lookup.

## Unpublished packages, consumed from the worktree

`@statewalker/webrun-rpc` (the MessagePort `connect`/`serve`) is **not
published** — npm 404. It and `webrun-site-builder` are consumed via `link:`
from a sibling `webrun-wire` worktree on branch `proto/lib-extraction`, built
there with `pnpm -r build`. Two consequences worth stating:

- The `dist/` boundary is real: these packages export `dist`, so a source edit
  in webrun-wire is invisible here until it is rebuilt.
- A defect found at this altitude can be fixed at its source rather than worked
  around, which is the reason for the worktree.

## Not covered

- **The browser's ServiceWorker rung.** `HostedSiteBuilder` (webrun-site-host)
  is the browser server-side path, and it rides `webrun-http-browser`'s
  **deprecated** transport (`sendStream` discards its chunk promise; no
  backpressure, no per-stream timeout). It is a fourth rung with different
  properties, not a fourth column of this table.
- **Bidirectional service over ONE port end.** Not needed here (client and
  server hold the two ends of a channel), and it does not work as shipped —
  `connect` and `serve` each build their own mux over the same byte stream.
- **Backpressure thresholds differ by rung** — `emulateMux`'s credit window on
  the port rung, yamux's on libp2p, none at all on direct. Any stall-threshold
  test is rung-specific and none is written.
- **No hub protocol yet.** The directive puts invitations, presence, revocation
  and renewal behind HTTP handlers too; this rung proves the transport ladder
  they will ride, not those handlers.
