# httpeers-protos

Runnable prototypes for **httpeers** — ordinary HTTP semantics over libp2p,
addressed by peer id, with identity that comes from the handshake rather than
from anything the caller says.

Every demo starts **real libp2p 3.3.8 nodes** over loopback TCP and performs a
real Noise handshake. There are no mocks and no in-process fakes: if a demo
prints a result, bytes crossed a yamux stream to get there.

```bash
pnpm demo:01-identity
pnpm demo:02-http-over-p2p
pnpm demo:03-access-control
pnpm demo:04-backpressure
pnpm demo:all           # all four, in order
```

Each exits non-zero if its claim fails, so `pnpm demo:all` is also a smoke test.

## The prototypes

| | Shows | Why it matters |
|---|---|---|
| **01-identity** | The server learns the peer id Noise proved, while the caller actively lies about who it is | This was impossible until recently — the stock adapter destructured `{ stream }` and discarded the connection one line before the handler, so nothing could know who was calling |
| **02-http-over-p2p** | A query string survives, and a streamed request body arrives in full | These are the two defects that made `@libp2p/http` unusable. Both were **silent**: the request appeared to succeed and quietly lost data |
| **03-access-control** | Deny by default; roles keyed to the proven peer; a forged `x-i-am-admin` header changes nothing | The unit of access is a *role*, not a peer id, so a provider needs no per-peer table — only a policy and the proven identity |
| **04-backpressure** | A 125 MiB streamed body completes intact while the producer stays throttled by the transport | libp2p 3.x's `onDrain()` memoises one promise and never clears it, so the obvious port silently buffers without bound |

## Layering

```
  your handler            (Request) => Promise<Response>
        |
  webrun-http-streams     serveFetchOverDuplex / fetchOverDuplex
        |                 HTTP semantics over a bytes-only Duplex
  webrun-streams-libp2p   serveConnections / connect
        |                 one libp2p stream per call; identity in the closure
  libp2p 3.3.8            Noise + yamux + TCP
```

`Duplex = (input) => AsyncGenerator<Uint8Array>` is bytes-only by ADR-0004 and
gains no parameter for identity. `serveConnections` builds the handler **per
inbound stream**, so the connection — and therefore `remotePeer` — lives in
that handler's closure. That is the whole trick, and it is why `Duplex` did not
have to change.

## A note on what these prove

Each demo asserts something that would actually *fail* if the property did not
hold — not something that passes either way. `04` is the clearest example: it
measures how much of the transfer window the producer spent still producing,
because a producer with no delay of its own can only be slowed by the transport
refusing data. Resident memory is deliberately **not** used, since 125 MiB of
sent chunks become garbage and RSS grows whether or not backpressure works.

The byte-level proof of `04` lives in
`webrun-streams-libp2p/tests/backpressure.test.ts`, which samples
`stream.writeBufferLength` directly.
