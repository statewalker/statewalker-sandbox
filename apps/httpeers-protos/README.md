# httpeers-protos

## What it is

Runnable prototypes for **httpeers** — ordinary HTTP semantics over libp2p,
addressed by peer id, with identity that comes from the handshake rather than
from anything the caller says.

Every network demo starts **real libp2p 3 nodes** over loopback TCP and performs a
real Noise handshake. There are no mocks and no in-process fakes: if a demo
prints a result, bytes crossed a yamux stream to get there.

## How to run it

From this folder, after `pnpm install` at the repo root:

```bash
pnpm demo:all           # all ten, in order
pnpm demo:06-open-relay # …or any one of them
pnpm typecheck
```

Each exits non-zero if its claim fails, so `pnpm demo:all` is also a smoke test.

Prototypes 01, 02, 03, 04 and 06 start **real libp2p nodes**. 05, 07, 08 and 09
exercise pure logic — routing, policy resolution, revocation and vocabulary —
which needs no network and is clearer without one. 10 uses **real Ed25519 keys
and real signatures** with no transport at all, deliberately: that block A can be
verified without a network stack is one of the things it establishes.

**The demos are not a snapshot of `@statewalker/httpeers.core`.** 07 and 09 use
a walked `.access` tree and a standalone role vocabulary; `httpeers.core`
expresses the same rules in Datalog. The properties they show are still
requirements; the mechanisms are not what ships. 10 mints and verifies real
Biscuit tokens with `@statewalker/webrun-biscuit`.

Every prototype folder carries its own `README.md` enumerating **exactly what
it verifies** — each claim, how it is established, what would make it fail, and
what it deliberately does not cover.

## Reference: what each prototype shows

| | Shows | Why it matters |
|---|---|---|
| **01-identity** | The server learns the peer id Noise proved, while the caller actively lies about who it is | A stock adapter that destructures `{ stream }` discards the connection before the handler, so nothing can know who is calling |
| **02-http-over-p2p** | A query string survives, and a streamed request body arrives in full | These are two silent failure modes of `@libp2p/http`: the request appears to succeed and quietly loses data |
| **03-access-control** | Deny by default; roles keyed to the proven peer; a forged `x-i-am-admin` header changes nothing | The unit of access is a *role*, not a peer id, so a provider needs no per-peer table — only a policy and the proven identity |
| **04-backpressure** | A 125 MiB streamed body completes intact while the producer stays throttled by the transport | libp2p 3.x's `onDrain()` memoises one promise and never clears it, so the obvious port silently buffers without bound |
| **05-router-mounts** | Longest-prefix mount resolution **on segment boundaries** — `/files` does not swallow `/filesystem` | Without the boundary rule a mount captures any name sharing its prefix, which looks fine until two mounts collide |
| **06-open-relay** | A peer refuses to forward for a stranger, and never dials on their behalf | Unguarded forwarding lets any peer use any other as an open relay. It hides because the *far* end still refuses — the caller sees a sensible 403 and never learns whose node did the dialling |
| **07-access-tree** | `.access` walked root→leaf, deny by default, with a traceable reason for every refusal | Grants name a **role in a mesh**, not a peer, so a provider needs no per-peer table. A malformed tree refuses to start rather than denying everyone silently |
| **08-revocation** | A removed member's live, unexpired token stops working within one heartbeat — and re-admission still works | Exposure becomes one heartbeat instead of the full TTL, and the hub stays off the request path. `iat` is what makes re-admission possible at all |
| **09-role-vocabulary** | Capabilities are the additive union of a token's roles; an unknown role grants **nothing** | The hub assigns roles and stays ignorant of capabilities. Namespacing (`std:` / `<mesh>/`) makes the mapping mesh-independent and self-certifying |
| **10-token-chain** | mint → attenuate → verify over real Ed25519 keys: binding, audience, expiry, revocation by device, and delegation | The token half every prototype above stubs. Plain attenuation is forgeable, so delegation needs a third-party block scoped with `trusting` |

## How a request reaches a handler

```
  your handler            (Request) => Promise<Response>
        |
  webrun-http-streams     serveFetchOverDuplex / fetchOverDuplex
        |                 HTTP semantics over a bytes-only Duplex
  webrun-streams-libp2p   serveConnections / connect
        |                 one libp2p stream per call; identity in the closure
  libp2p 3                Noise + yamux + TCP
```

`Duplex = (input) => AsyncGenerator<Uint8Array>` is bytes-only and has no
parameter for identity. `serveConnections` builds the handler **per
inbound stream**, so the connection — and therefore `remotePeer` — lives in
that handler's closure. That is the whole trick, and it is why `Duplex` needs no
identity parameter.

## Which demos run shipped code

01, 02, 03, 04 and 06 run against the published packages
`@statewalker/webrun-streams-libp2p` and `@statewalker/webrun-http-streams`.

05, 07, 08 and 09 run small local implementations in `lib/` (`router.ts`,
`access-tree.ts`, `revocation.ts`, `vocabulary.ts`). They demonstrate the
mechanisms; they are not the code any package ships.

## What will surprise you: what these prove, and what they do not

Each demo asserts something that would actually *fail* if the property did not
hold — not something that passes either way. `04` is the clearest example: it
measures how much of the transfer window the producer spent still producing,
because a producer with no delay of its own can only be slowed by the transport
refusing data. Resident memory is deliberately **not** used, since 125 MiB of
sent chunks become garbage and RSS grows whether or not backpressure works.

`04` does not sample `stream.writeBufferLength`; the byte-level check of
backpressure belongs to the tests of `@statewalker/webrun-streams-libp2p`.
