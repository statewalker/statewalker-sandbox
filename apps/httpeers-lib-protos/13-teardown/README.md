# 13 — Why `close()` and not `.return()`? A diagnosis, a MessagePort repro, and a fix

`pnpm test 13-teardown`

**Answer: it was a defect in two places, it reproduces with no libp2p at all,
it is fixed at the source — and one part of it is a property of JavaScript that
no library can fix.**

Rungs 09 and 10 both hit this and both worked around it by tearing down the
whole connection. Twice is a defect report.

## What was wrong

| | symptom | cause |
|---|---|---|
| **libp2p** (`duplexOverStream`) | `.return()` **hung for ever** | its `finally` did `await outboundSource.return?.()` then `await outbound`; neither settles while the producer is parked |
| **MessagePort** (`emulateMux`) | `.return()` returned, but the producer **leaked** | the outbound pump is fire-and-forget and checked `closed` only *after* a chunk arrived, so nothing ever cancelled the input |

The shared root cause: **teardown depended on the input settling**, and
`.return()` on an async generator parked awaiting its own source is *queued
behind that pending `next()`* — it is not preemptive. A long-lived producer
spends its entire life inside `next()`.

## Verified

| # | Claim | Transport |
|---|---|---|
| 1 | `.return()` settles promptly | MessagePort |
| 2 | The producer is cancelled, so its `finally` runs | MessagePort |
| 3 | `.return()` settles promptly — **it used to hang for ever** | libp2p |
| 4 | The producer is cancelled, so its `finally` runs | libp2p |
| 5 | **Language limit**: a producer parked on an unresolvable `await` cannot be unwound by anyone | libp2p + direct |
| 6 | **The remedy**: a producer that races a cancellation signal does unwind | libp2p |

Measured 2026-09-12, all six pass.

## The fix, in the sibling `webrun-wire` worktree

- `duplexOverStream` cancels **without awaiting**, and aborts the stream so the
  peer is told rather than left guessing.
- `emulateMux` gained `Stream.cancelInput`, so teardown reaches the producer
  instead of waiting for it.
- Both acquire the producer's iterator **once**, because `.return()` on a
  wrapper generator is queued behind the wrapper's own pending `next()`.
- `framedOutbound` propagates cancellation in its `finally` — **a regression I
  introduced and a test caught**: replacing its `for await` with a hand-driven
  loop removed the implicit `input.return()` that used to unwind a *server's*
  handler when its caller walked away. `cancel-server-handler.test.ts` pins
  that direction now.

Regression tests live with the code: `emulate-mux-cancel-input.test.ts`,
`cancel-open-input.test.ts`, `cancel-server-handler.test.ts`. All four
packages' suites pass (**582 tests**), including a guard that a call whose
input ends *naturally* still completes gracefully.

## What cannot be fixed, and what it means for the API

`.return()` on a generator suspended at an `await` that never settles is
queued for ever. No caller, no transport, no library can unwind it — claim 5
measures it directly and then through the transport, so nobody mistakes it for
a transport defect.

> **Therefore a long-lived producer must be given a cancellation signal.**
> The iterator protocol cannot cancel a waiting producer, so the API has to.

Claim 6 shows the shape that works: the producer races its wait against an
`AbortSignal`, and a caller's abort unwinds it. Any mesh API that hands out
long-lived streams needs that signal in its contract, not in its documentation.

## Two claims elsewhere became features

- **Rung 09 claim 10** asserted `.return()` never completes and `close()` was
  the only teardown. It now asserts that `.return()` settles promptly.
- **Rung 10 claim 6** asserted the client is never told *why* a revoked stream
  ended. It now asserts the client **is** told: the guard's `StreamRevoked` is
  serialised by the framing layer and arrives as a rejection carrying its
  reason. The heartbeat is still where a peer with no open stream learns it was
  removed.

## Not covered

- **No browser run.** `MessageChannel` here is Node's; a real page adds
  transferable-port semantics and a structured-clone boundary.
- **Backpressure interaction.** The port mux grants an 8 MiB credit window, so
  an unthrottled producer *floods* rather than parks — which is why these
  claims use a ticking producer. Cancelling a producer that is blocked on
  credit is untested.
- **`maxStreams` accounting under repeated cancellation** is not measured; the
  slot is released on teardown, but nothing here opens thousands to prove it.
