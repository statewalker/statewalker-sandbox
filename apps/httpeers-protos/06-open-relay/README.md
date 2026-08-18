# 06 — A peer refuses to be used as an open relay

`pnpm demo:06-open-relay`

Runs against the **real shipped packages** over two real libp2p 3.3.8 nodes,
with `lib/router.ts` (a reconstruction) supplying the forwarding policy.

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | A request addressed to the serving peer itself is handled normally | `GET /{server}/anything` → **200** | Legitimate local traffic is broken by the guard — the failure mode of an over-broad fix |
| 2 | A request addressed to a **third party** is refused | `GET /{stranger}/secret` → **403** with an explicit reason | The forward is attempted |
| 3 | The refusal happens **before any dialling** | A counter increments inside the `remote` dial path; asserted to be exactly **0** | The node dials and only then refuses — which is the actual bug, since the work has already been done |
| 4 | The refusal names the requester | The 403 body carries `from`, the Noise-proven peer id | The identity is taken from the request rather than the connection |
| 5 | Forwarding is **deny by default** | With `allowForward` absent, `lib/router.ts` refuses outright rather than falling open | A missing policy means "allow" |
| 6 | The policy is keyed to the proven peer | `allowForward(request, target, from)` receives `context.remotePeer` | It could be spoofed by the caller |

Exit code is 0 only if the third-party request was refused **and** the dial
counter is zero.

## Why this exists

This was a real defect, found by code review rather than by tests. The router
forwards requests addressed to other peers, and access was enforced only on the
**local** branch — so any peer could ask any other peer to forward on its
behalf. An open relay.

It stayed invisible because it **failed closed at the far end**: the third party
refused the relayed request, so the caller saw a sensible error and nothing
looked wrong. The victim was the intermediate node, which had spent a dial, a
handshake and bandwidth on a stranger's behalf. That is why claim 3 asserts on
the dial counter rather than on the response status — the status was always
fine.

## Not covered here

- **No real third peer.** The `remote` hook is instrumented rather than
  dialling a genuine third node; the point being proven is that it is *never
  reached*.
- **Chained forwarding (A→B→C) is not exercised.** Whether identity re-proves
  at each hop, and whether a hop limit is needed to prevent cycles, are open
  questions in the design.
- **No delegation model.** There is no way here for a peer to legitimately
  authorise another to forward for it; the trusted set is a bare allowlist.
