# httpeers-protos

Runnable prototypes for **httpeers** — ordinary HTTP semantics over libp2p,
addressed by peer id, with identity that comes from the handshake rather than
from anything the caller says.

Every demo starts **real libp2p 3.3.8 nodes** over loopback TCP and performs a
real Noise handshake. There are no mocks and no in-process fakes: if a demo
prints a result, bytes crossed a yamux stream to get there.

```bash
pnpm demo:all           # all nine, in order
pnpm demo:06-open-relay # …or any one of them
```

Each exits non-zero if its claim fails, so `pnpm demo:all` is also a smoke test.

Prototypes 01, 02, 03, 04 and 06 start **real libp2p nodes**. 05, 07, 08 and 09
exercise pure logic — routing, policy resolution, revocation and vocabulary —
which needs no network and is clearer without one.

Every prototype folder carries its own `README.md` enumerating **exactly what
it verifies** — each claim, how it is established, what would make it fail, and
what it deliberately does not cover.

## The prototypes

| | Shows | Why it matters |
|---|---|---|
| **01-identity** | The server learns the peer id Noise proved, while the caller actively lies about who it is | This was impossible until recently — the stock adapter destructured `{ stream }` and discarded the connection one line before the handler, so nothing could know who was calling |
| **02-http-over-p2p** | A query string survives, and a streamed request body arrives in full | These are the two defects that made `@libp2p/http` unusable. Both were **silent**: the request appeared to succeed and quietly lost data |
| **03-access-control** | Deny by default; roles keyed to the proven peer; a forged `x-i-am-admin` header changes nothing | The unit of access is a *role*, not a peer id, so a provider needs no per-peer table — only a policy and the proven identity |
| **04-backpressure** | A 125 MiB streamed body completes intact while the producer stays throttled by the transport | libp2p 3.x's `onDrain()` memoises one promise and never clears it, so the obvious port silently buffers without bound |
| **05-router-mounts** | Longest-prefix mount resolution **on segment boundaries** — `/files` does not swallow `/filesystem` | Without the boundary rule a mount captures any name sharing its prefix, which looks fine until two mounts collide |
| **06-open-relay** | A peer refuses to forward for a stranger, and never dials on their behalf | A real defect found by review: forwarding was unguarded, so any peer could use any other as an open relay. It hid because the *far* end still refused — the caller saw a sensible 403 and never learned whose node did the dialling |
| **07-access-tree** | `.access` walked root→leaf, deny by default, with a traceable reason for every refusal | Grants name a **role in a mesh**, not a peer, so a provider needs no per-peer table. A malformed tree refuses to start rather than denying everyone silently |
| **08-revocation** | A removed member's live, unexpired token stops working within one heartbeat — and re-admission still works | Exposure becomes one heartbeat instead of the full TTL, and the hub stays off the request path. `iat` is what makes re-admission possible at all |
| **09-role-vocabulary** | Capabilities are the additive union of a token's roles; an unknown role grants **nothing** | The hub assigns roles and stays ignorant of capabilities. Namespacing (`std:` / `<mesh>/`) makes the mapping mesh-independent and self-certifying |

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

## Reconstructions, and what that means

01, 02, 03, 04 and 06 run against the **real shipped packages** —
`webrun-streams-libp2p` and `webrun-http-streams` — so they exercise code that
lives in the repo.

05, 07, 08 and 09 are **reconstructions**. The archived prototypes for the
router, `.access` tree, revocation and role vocabulary were saved as *deltas*
(only the files each version added), and the tree they applied to no longer
exists in the archive. These implement the same mechanisms from the recorded
findings, in `lib/`, so the behaviour is demonstrable and testable today. They
are not the code that passed the original 135 tests, and are not a substitute
for it.

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
