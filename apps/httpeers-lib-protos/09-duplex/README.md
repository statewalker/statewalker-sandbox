# 09 — Does the second altitude work: duplex streams over the mesh?

`pnpm test 09-duplex`

**Answer: yes, including genuine full duplex — and the teardown rule is the
opposite of what the generator protocol suggests.**

Ten claims over two real libp2p nodes, a real Noise handshake, and the duplex
protocol registered beside the fetch one.

## Why a second altitude at all

`Handler = (Request) => Promise<Response>` cannot express a WebSocket, an A2UI
message stream, or anything where both ends keep talking. It never could —
**fetch is not the foundation of this stack but a narrowing of it**.
`@statewalker/webrun-http-streams` builds fetch semantics *on* a `Duplex`, and
`httpeers.core`'s transport performs that narrowing at two call sites.
webrun-wire's ADR-0004 states it outright: `Duplex` is "the canonical adapter
seam". So adding duplex **removes a restriction** rather than adding a layer.

```ts
Duplex = (input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>
```

## Verified

| # | Claim | Result |
|---|---|---|
| 1 | Bytes cross both ways over a real handshake | 23 ms |
| 2 | **Half-close**: the handler keeps yielding after the caller's input ends | the WebSocket-shaped property |
| 3 | The handler is told the **proven** peer, as an argument | matches the caller's peer id; the token beside it is a *claim* |
| 4 | An unmounted path fails the stream rather than hanging | rejects with `no mount` |
| 5 | Cancellation reaches the producer | the handler's `finally` runs |
| 6 | The A2UI adapter survives a `send()` **before anything pulls** | the bug a reviewer found by execution |
| 7 | Several streams run concurrently and do not mix | 4 streams, 4 distinct replies |
| 8 | The same codec chain works with **no transport at all** | 2 ms, loopback |
| 9 | **Full duplex**: a reply arrives while the caller's input is *still open* | two exchanges, neither side closed |
| 10 | **Hazard**: `.return()` on an open-input duplex never completes; `close()` does | measured, 3 s budget |

Measured 2026-09-12, all ten pass.

## Three findings worth more than the claims

**1. Full duplex genuinely works (claim 9).** Every other claim sends an input
that *ends*; a WebSocket does not. With the input held open, a push is taken,
the server replies, and the reply arrives — twice — with neither side closing.
The transport is full duplex by construction: `duplexOverStream` runs its
outbound pump as a concurrent task while the inbound loop yields frames.

**2. `.return()` is the wrong teardown, and it hangs (claim 10).** The async
generator protocol says a consumer should `.return()`, and `webrun-streams`'
own documentation makes the consumer responsible for it — otherwise a stream
slot leaks on *both* peers. With the caller's input still open it **never
resolves**: the outbound pump is parked awaiting the next value, so nothing
unwinds. `close()` aborts the underlying stream and completes.

> **The rule: to stop a duplex whose input is still open, call `close()`.**
> This is why `PeerDuplex.close()` exists rather than leaving callers to the
> generator protocol. It cost two 60-second test timeouts to find, and it would
> have cost an application a permanent hang.

**3. The A2UI adapter's real bug, fixed (claims 6 and 8).** A reviewer found
by *executing* an earlier sketch that it threw on its first `send()`:
`newAsyncGenerator`'s init callback does not run — and `push` is not assigned —
until the generator is **first pulled**, and the sketch's `let push!:` hid that
from the compiler. The fix is a queue that predates the generator, so `send()`
never touches `push` directly. Claim 8 pins the same behaviour with no
transport, so a future failure is immediately attributable to one side or the
other.

## Design consequences, carried into the API

- **Identity is an argument here, not a lookup.** The fetch path carries the
  proven peer in a `WeakMap<Request, …>` written inside the per-stream closure;
  a duplex has no `Request` to key on, so `DuplexContext.peerId` is passed in.
  `serveConnections` supplies the only claim that cannot be forged by the
  payload.
- **Addressed by `(peerId, path)`, never by a URL.** A duplex stream has no
  request-line, and reusing `peer://…` would re-open the URL-derived-peer hole
  rung 06 exists to close.
- **A separate protocol id** (`/httpeers-duplex/1.0.0`) so the fetch path is
  untouched and cannot regress.
- **The open frame is the existing envelope** (`encodeMessage`/`decodeMessage`)
  — nothing new on the wire.

## Not covered

- **Authorisation is checked once, at open.** A long-lived stream outlives a
  revocation: `hub.remove()` does not interrupt it. That is rung 10's question
  and it is a real hole, not a detail.
- **Backpressure is not proven here.** The conformance suite's L6 on libp2p is
  "an end-to-end integrity check and nothing more" (its own README); yamux's
  credit window is what actually applies it, and nothing in this rung measures it.
- **The stream cap is not exercised.** A second protocol id doubles the
  per-connection ceiling (`maxInboundStreams` is per-protocol); this rung opens
  at most four.
- **No browser run.** Both peers are Node. The duplex primitives are
  isomorphic in principle, and `webrun-streams-webrtc` implements the same
  seam, but nothing here demonstrates it.
