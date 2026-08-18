# 01 — Identity survives by closure

`pnpm demo:01-identity`

Runs against the **real shipped packages**: `@statewalker/webrun-streams-libp2p`
and `@statewalker/webrun-http-streams`, over two real libp2p 3.3.8 nodes on
loopback TCP with a real Noise handshake.

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | The serving side receives a `ConnectionContext` carrying `remotePeer` | `serveConnections` invokes the handler factory with a context; the handler reads `context.remotePeer` | The context is absent or `remotePeer` is undefined |
| 2 | That id is the one the **handshake proved**, not one the caller supplied | Asserted equal to `client.peerId.toString()`, which libp2p generated locally and never transmitted as a claim | The ids differ |
| 3 | A **forged identity claim is ignored** | The request carries `?iam=definitely-someone-else`; the server echoes the claim back but decides on `remotePeer` | The server's answer is influenced by the query parameter |
| 4 | Ordinary HTTP works end to end over the stream | `fetchOverDuplex` → HTTP 200 with a JSON body | Non-200, or a transport error |
| 5 | The handler is built **per inbound stream**, so the connection lives in its closure | `serveConnections` takes `(context) => Duplex` and calls it per stream | A hoisted or memoised handler would give two connections one identity |
| 6 | `Duplex` is unchanged and remains bytes-only | The handler returned is an ordinary `Duplex`; no parameter was added to carry identity (ADR-0004) | Identity had to be threaded through `Duplex` or `Serve<P>` |

Exit code is 0 only if the proven id matches the real client id.

## Why this exists

Until recently this was impossible. The stock adapter destructured only
`{ stream }` from libp2p's handler callback and discarded the connection one
line before the handler ran, so nothing on the serving side could know who was
calling — and a cast erased the real signature, so TypeScript could not warn.
Every identity, membership and authorization design in this project was blocked
on it.

## Not covered here

- **No token verification.** There is no JWT, no signature check, no expiry.
  Identity here is possession proven by the transport, which is the foundation
  a token model sits on — see 03, 07 and 08 for the layers above it.
- **One connection, one stream.** Concurrent streams from different peers are
  not exercised; the per-stream construction that makes that safe is verified
  by reading, and by the package's own tests.
- **No relay or WebRTC.** Direct TCP on loopback. Browser-to-browser transport
  is `p2p-demo`'s territory.
