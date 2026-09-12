# 07 — Can the API build the consumers a critic could not?

`pnpm test 07-api-types`

**Answer: yes, and the compiler says so in 642 ms.** The two consumers an
adversarial review declared NOT BUILDABLE — the e2e harness and the consumer
page — are ported against the API here and typecheck clean, together with a
negative control proving the API also *rejects* what it must.

## Why this rung is different

Rungs 01–06 answered questions about behaviour by running code. This one
answers a question about a *contract*, and it exists because three rounds of
adversarial review over a **prose** specification produced:

- fixes that introduced worse defects than they closed (one of six fatal items
  cleanly fixed; two regressed, one into a fails-**open** state),
- two consumers that still could not be built,
- and a new mis-citation in every round.

Meanwhile that review's two most valuable findings came from **typechecking an
example** and **executing a sample**. The medium was the problem: prose has no
compiler. So the API moved into TypeScript, where a missing seam is a build
error rather than a paragraph somebody has to notice.

## What is here

| File | Role |
|---|---|
| `src/api.ts` | The candidate API, types only. No implementation anywhere in this rung. |
| `src/stubs.ts` | The platform constructors, `declare`d — transport, access, stores, hosting. |
| `ports/e2e-harness.ts` | `tests/e2e/harness.ts` rewritten against the API. |
| `ports/consumer-page.ts` | `pages/app/main.ts` + `browser/session.ts` rewritten against the API. |
| `ports/must-not-compile.ts` | The negative control: 11 `@ts-expect-error` assertions. |
| `tests/compiles.test.ts` | Runs `tsc` and reads the exit code. The compiler is the test. |

## Verified

| # | Claim | How it is established |
|---|---|---|
| 1 | The rung typechecks — both ports and the control | `tsc -p tsconfig.json` exits 0 with empty output |
| 2 | Both NOT-BUILDABLE consumers are expressible | They are ported, and claim 1 covers them |
| 3 | The control is not vacuous | 11 `@ts-expect-error`s; if the API stops rejecting one, TypeScript reports an *unused* expect-error and claim 1 goes red |

Measured 2026-09-12.

## What the negative control forbids

Each line is a defect an independent critic proved against the prose design:

- an **unpoliced mount** — `policy` was optional, so the security default was
  one nobody chose, and the flagship example shipped an unguarded mount;
- a **policy as a bare string** — deferring every mistake to the first request,
  which is how the prototype got a mount that denied everything forever;
- **`callerOf(req) === undefined`** — the overload that meant both "unbound, a
  bug" and "ours, forward it and attach our token", and so failed **open**;
- **a peer id read off an un-narrowed `Caller`**;
- **a string where key bytes belong** — which would have silently re-minted
  every stored identity;
- **a hand-built `Landing`** — `appPath` validation was defeated by a backslash
  (`new URL("/\evil.com/x", "http://peer.local/").host === "evil.com"`, measured);
- **minting from a member's `Access`** — the prose design added minting by
  deleting the verifier's issuer, leaving members unable to check a signature;
- **an invitation id with no mesh** — `?invite=<id>` is what the Node hub prints
  and every Playwright test opens.

## What the ports found that the API still lacks

Recorded as findings rather than silently patched:

- **H-1** — the **relay process** has no home. It is a libp2p node with a
  circuit-relay service and no mesh identity, so it belongs to the transport
  package; but every deployment and every e2e run needs one.
- **H-2** — `readJoinInput` returns `T | null`; a harness and a just-scanned QR
  both want the throwing form. Ship both, or every caller writes the wrapper.
- **P-1** — a page must import a key-shaped function to render its own peer id.
  `IdentityStore.peerId()` would keep key bytes out of page code.
- **P-2** — there is no way to ask "what peer id would I have" without creating
  the key as a side effect of rendering a screen.

## Not covered

- **No implementation exists**, so nothing here proves the API can be *built* —
  only that consumers can be *written* against it. Rungs 08+ take the seams
  that are still open (the gateway's three hosting modes, duplex authorisation
  over a long stream, revocation mid-stream) and run them.
- **Three consumers are not yet ported**: the hub in a tab, the Node hub, and
  the proxy page. The two hardest were done first deliberately.
- **The gateway** is declared (`createGateway`) and used by the consumer page,
  but its three hosting modes are stubs here; the research grounding them is in
  the session scratchpad and rung 09 is where they run.
