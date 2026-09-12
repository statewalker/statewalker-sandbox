# 12 — The hub protocol as nothing but HTTP

`pnpm test 12-hub-http`

**Answer: the entire membership lifecycle runs over direct calls, a
MessagePort and libp2p, with byte-identical hub and client code and exactly
two seams swapped.**

The directive: *"All hub functionalities including invitations, revocations,
presence, tokens renewals etc should be implemented as HTTP handlers and the
corresponding client calls (with fetch) without implication of libp2p layers…
Ideally the full set of these functionalities should be implemented and tested
locally using fetch handlers with direct calls, and after that re-configured
and tested over MessagePorts and P2P connections."*

Built red-first: neither the site nor the client existed when the tests were
written.

## Measured, 2026-09-12

| | direct | port | libp2p |
|---|---|---|---|
| lifecycle | `joined:member · renewed:true · ttl:5000 · members:1 · offers:images · after-removal:refused · denied:true` | identical | identical |

Fifteen claims in two files: ten over direct calls (the protocol itself) and
five over the ladder (that the protocol does not depend on its transport).

| # | Direct-call claims |
|---|---|
| 1 | A member redeems an invitation over HTTP and receives a token |
| 2 | An invitation is single-use, and the refusal says why |
| 3 | An unknown invitation is refused rather than granted |
| 4 | A heartbeat **renews** the token and reports versions |
| 5 | A stale sequence number is refused |
| 6 | A non-member's heartbeat is refused, so presence cannot be forged |
| 7 | The mesh view lists members and their advertisements |
| 8 | **Revocation**: a removed member is refused and appears in the deny list |
| 9 | Roles change, the policy version bumps, and the renewed token carries them |
| 10 | An unknown role is refused at invitation time, not at redemption |

## The one seam that matters

The hub reads who is calling through **one injected function**:

```ts
callerOf: (request: Request) => string | undefined
```

The prototype's hub reaches the same fact through `lookupPeer`, a module-level
WeakMap the transport writes. That works, and it makes the hub untestable
without a network. As a parameter, the hub's code is identical on all three
rungs — but **what the answer is worth is not**:

| rung | who fills it | worth |
|---|---|---|
| direct | the caller, in a header | a **claim** |
| MessagePort | the caller, in a header | a **claim** |
| libp2p | `serveConnections` → `context.remotePeer`, per inbound stream | a **proof** (Noise) |

Claim 5 measures the difference instead of describing it: the libp2p client
sends `x-peer: <somebody else>` on *every* request, and its lifecycle still
belongs to its own proven peer id. On the lower rungs that header **is** the
identity. An API that blurred the two would be claiming an enforcement it does
not have.

## What is reused rather than rewritten

`hub/hub-state.ts`'s invitation and member logic (single-use ids over a
snapshot) and `httpeers.core`'s presence and advertisement stores. Those are
proven; the HTTP surface around them is what this rung adds. Three behaviours
were kept deliberately because the prototype's comments explain them:

- advertisements are re-read from **every** beat — `[]` withdraws, omission
  leaves them alone;
- an unknown role is refused when the **invitation** is minted, so an operator
  who mistypes learns immediately rather than when a guest cannot get in;
- a role change is itself a revocation: every token already issued carries the
  old roles and nothing can recall them.

## Not covered

- **No admin HTTP routes.** `invite`, `setRoles` and `remove` are in-process
  methods, not endpoints, because nothing remote may mint membership. A real
  deployment needs an authenticated admin surface, and that is a separate
  design with its own threat model.
- **Presence expiry is not driven here.** `sweep()` exists and the store owns
  expiry; no test runs the timer, so "a peer that stops beating leaves the
  view" is rung 01's claim, not this one's.
- **ETags are emitted, never checked.** The client does not send
  `if-none-match`, so the 304 path is unexercised.
- **The token is not yet presented back to the hub.** Redemption and presence
  are authorised by the caller seam alone; a deployment would also verify the
  bearer token on presence, which rung 11 proves is possible with no libp2p.
