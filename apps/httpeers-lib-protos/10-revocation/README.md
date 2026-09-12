# 10 — Does a revocation reach a stream that is already open?

`pnpm test 10-revocation`

**Answer: it does now, and the fix had to move twice before it was real.**

Rung 09 left the hole and named it: a duplex is authorised **once**, at open.
The fetch path re-verifies every request, so a revoked member is refused within
one heartbeat. A stream has no second request — so a removed member kept
talking for as long as it liked. An A2UI session lasts minutes; a tunnel lasts
hours.

Built red-first: `revocation-guard.ts` did not exist when the tests were
written, and two of the four in-process claims failed against the first
implementation.

## Verified

| # | Claim | Where |
|---|---|---|
| 1 | A member revoked mid-stream stops being served | in-process |
| 2 | A stream **idle in both directions** is still interrupted | in-process |
| 3 | Revoking someone else does not disturb this stream | in-process |
| 4 | The handler's own `finally` runs when a revocation cuts the stream | in-process |
| 5 | The server stops serving a revoked member **over a real libp2p connection** | libp2p |
| 6 | **Hazard**: the client is not told *why* — the stream just ends | libp2p |

Measured 2026-09-12, all six pass. No libp2p in claims 1–4, deliberately: the
directive is that access validates with no libp2p involvement, so a guard that
needed a connection object would be the wrong seam.

## Three things the tests found that reading would not have

**1. Interrupting the output is not enforcement (claim 5).** The first guard
checked on the way *out* — and the handler's own log showed `served:after`
**after** the member was revoked. By the time a reply is suppressed the handler
has already consumed the chunk and done whatever it does: written a file, sent
a message, charged a card. The check belongs on the **input** side, before the
chunk reaches the handler at all. A guard that only withholds replies protects
nothing that matters.

**2. Guarding one direction hangs (claims 2 and 4).** A long-lived handler
spends its life awaiting *input*. Interrupt only the output and its `await`
never settles: the `finally` never runs, and `iterator.return()` queues behind
a `next()` that will never resolve — so the guard itself becomes the hang.
Racing the **input** pull is what lets the handler unwind normally, which then
settles the output. Both directions, or neither.

**3. The dangerous stream is the quiet one (claim 2).** A per-chunk check costs
a map lookup and catches every *active* stream, but an idle tunnel produces no
chunk to hang a check on — and it is precisely the stream an operator believes
they have cut off. Hence two triggers: per chunk, and a timer.

## The hazard that is not fixed here (claim 6)

The server stops serving, and **the client is never told why**. What arrives is
a clean end-of-stream with no reason — or, in an earlier arrangement, nothing
at all for 20 seconds. A UI cannot distinguish "you were removed" from "the
peer finished"; both render as silence. This is the same shape as rung 09's
teardown hazard: while the outbound half is open, the stream does not report
the other end's state.

**The remedy is not at this altitude.** A member learns it was removed from the
membership heartbeat's typed refusal — a fetch call on its own schedule. So:

> **A long-lived stream must never be a peer's only liveness signal.**
> An API that implies otherwise is lying to its callers.

## Not covered

- **Revocation latency is not bounded here.** `pollMs` is 20–50 ms in these
  tests; a deployment's real bound is the revocation *distribution* interval
  (the heartbeat), not this timer.
- **`iat`-based re-admission is implemented and only lightly tested** — a token
  minted after a revocation is accepted; there is no test for the clock skew
  that would make that decision wrong.
- **No browser run.** Both peers are Node.
- **The guard is not wired into the fetch path**, which does not need it: every
  request re-verifies. Nothing here changes that path.
