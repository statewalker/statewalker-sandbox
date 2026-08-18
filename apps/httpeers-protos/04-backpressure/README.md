# 04 — Backpressure is real, not nominal

`pnpm demo:04-backpressure`

Runs against the **real shipped packages** over two real libp2p 3.3.8 nodes.
125 MiB is streamed through a genuinely slow consumer.

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | A large streamed body arrives **complete** | 2000 × 64 KiB sent; the server sums what it read and the total must equal 131 072 000 bytes exactly | Any truncation, silent or otherwise |
| 2 | The transfer is **paced by the consumer**, not buffered | The producer has no delay of its own, so the only thing that can slow it is the transport refusing more data. The demo measures what fraction of the transfer window the producer spent still producing; observed ≈ **87%** | A ratio near zero — the producer racing to completion while the response arrives much later — which is precisely what buffering looks like |
| 3 | Completion and pacing are asserted **together** | Exit code requires both | Either alone could be satisfied by a broken implementation |

## The measurement, and two rejected ones

This is worth stating because two obvious instruments **do not work here**, and
both were tried:

- **Elapsed time is not a discriminator.** The response cannot arrive until the
  slow consumer has read everything, so total elapsed is roughly the same
  whether the writer paced itself or dumped 125 MiB into a buffer.
- **Resident memory is not a discriminator.** The 125 MiB of sent chunks become
  garbage immediately. RSS grows either way, and an RSS-based assertion
  reported a *failure* against known-correct code.

What does differ is **when the producer finishes relative to the response**. A
producer with no internal delay finishes almost immediately if its output is
being absorbed by a buffer, and finishes near the end of the transfer if it is
being throttled. That is the assertion.

## Why this exists

libp2p 3.x replaced the pull-based `sink(AsyncIterable)` with a push-based
`send()` + drain model. The obvious port —

```ts
if (!stream.send(chunk)) await stream.onDrain();
```

— looks correct and is not. `@libp2p/utils`' `onDrain()` memoises a single
promise and **never clears it**, so every wait after the first returns an
already-settled promise while `writableNeedsDrain` is still true. The write
buffer then grows without bound, because yamux sets
`maxWriteBufferLength: Infinity`.

A code review caught it. **No test in the suite could have**: across the entire
suite `send()` returned `false` exactly twice, both on the first cycle of a
fresh stream — the one case the bug does not affect.

## Not covered here

- **The byte-level proof is elsewhere.** `webrun-streams-libp2p/tests/backpressure.test.ts`
  samples `stream.writeBufferLength` directly and asserts it stays bounded
  (0 B with the fix, ~36 KB without). That is the authoritative instrument;
  this demo is the end-to-end consequence.
- **Inbound flow control is absent** and is a known, recorded limitation: the
  read side pushes into an unbounded queue regardless of consumer rate.
- **No failure injection.** Peer stalls, resets and mid-transfer disconnects
  are not exercised.
