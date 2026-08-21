# 10 — mint → attenuate → verify

**Run:** `pnpm demo:10-token-chain`
**Network:** none. Real Ed25519 keys, no transport, by design — that is criterion A-19.
**Spec:** `docs/superpowers/specs/2026-08-20-httpeers-api-design.md` §6 ·
ADR-0009, ADR-0010, ADR-0016, ADR-0017, ADR-0019, ADR-0020

---

## Why this exists

Every earlier prototype stubbed the token. Protos 03, 07 and 09 were handed
`{mesh, roles}` directly, or read a local map keyed by peer id; **no JWT or Biscuit
was ever minted, signed or verified anywhere in this project.** The binding rule was
*demonstrated* but had no token half.

ADR-0019 then adopted Biscuit and Datalog on the strength of a code review of
`google/sam` — the only load-bearing decisions in this design reached without
something that runs. This prototype is the repayment. It exercises the whole chain
against real keys and turns the DESIGNED criteria of §6.8 into observed behaviour.

## What is verified

23 scenarios plus one control, each printing its finding.

| Scenario | Criterion | What it establishes |
|---|---|---|
| T10-01…04 | A-01 | mint → verify; role implication derives capabilities transitively; nothing grants `DELETE`, so nothing permits it |
| T10-05 | A-11 | a token presented over a **different** proven key is refused |
| T10-06 | A-12 | a server that received Alice's token cannot replay it elsewhere |
| T10-07 | A-13 | with no delegation permission minted, an appended `delegate` block changes nothing |
| **T10-08** | — | **a thief appending a plain `delegate` block naming itself is refused** |
| **T10-09** | — | **a third-party block signed by Alice's device key naming the proxy is accepted** |
| T10-10, 11 | — | the delegation narrows (proxy may `GET`, not `PUT`) while Alice keeps `PUT` |
| T10-12 + **12b** | A-23 | an appended block cannot grant a role — with a **control** proving the same policy *does* match when the hub granted it |
| T10-13, 14 | A-24 | an audience-scoped token works at its destination and is refused by another, **by that destination** |
| T10-15 | A-14 | expiry, against the injected clock |
| T10-16 | A-15 | a token verified against a different mesh key fails on the signature, not on logic |
| T10-17, 18 | A-20 | a constraint the verifier has never heard of **denies**; supplying the predicate allows |
| T10-19…21 | A-21 | revoking one binding removes one device and leaves the subject's others; revoking the subject removes all |
| T10-22 | A-25 | a rule set that explodes denies (`TooManyFacts`) rather than hanging |
| T10-23 | A-19 | the source files are scanned for transport imports; none |

## How it is established

Real `Ed25519` key pairs from `@biscuit-auth/biscuit-wasm@0.6.0` — a hub key, and a
separate device key for Alice. Tokens are serialized to base64 and re-parsed with
`Biscuit.fromBase64(data, rootPublicKey)`, so **every scenario verifies a real
signature over real bytes**, not an in-memory object handed around.

Facts the node asserts — `connection_peer`, `self_peer`, `time`, `operation`,
`resource` — are supplied by the verifier and never read from the token.

Denials print the failing check with its block id and rule text, which is the spec's
P8 explainability, e.g.

```
failed -> block 0 check 0: check if bound($k), connection_peer($k)
failed -> block 1 check 0: check if operation("GET")
```

## What would make it fail

- Any scenario's expected verdict flipping. Each pairs an allow with the matching
  deny over the *same* token, so a change that breaks one surfaces as a mismatch
  rather than as silence.
- T10-12 losing its control 12b — `NoMatchingPolicy` is also what a policy that can
  never match looks like, so the pair is the proof, not T10-12 alone.
- T10-09 passing while T10-08 also passes. That pair is the security claim; both
  outcomes are required.

---

## Findings

### F1 — `authorize()` is unusable; `authorizeWithLimits` is mandatory

With this build's default limits, `Authorizer.authorize()` throws
`{ RunLimit: 'Timeout' }` on a single-fact policy. Every call must pass explicit
limits. **P9's evaluation budget is therefore not a hardening measure that can be
deferred — nothing works without it.**

### F2 — the TIME limit is broken under WASM; a start-up warm-up is mandatory

The first `authorizeWithLimits` call in a process throws `{ RunLimit: 'Timeout' }`
**regardless of `max_time_micro`.** Measured identically at `1_000` and at
`1_000_000_000` (≈1000 s), while the call itself takes ~30 ms of one-time warm-up.
The limit is not being honoured; the clock underneath it is wrong.

`max_facts` and `max_iterations` are unaffected and do work — T10-22 is caught by
`TooManyFacts`, not by the timer.

Mitigation, implemented as `warmUp()` in `tokens.ts`: throw away one authorization on
a disposable key at start-up. **A peer that skips this fails its first authorized
request closed, for no reason.** This is the ADR-0019 maturity risk arriving on
schedule.

### F3 — plain attenuation is forgeable; delegation needs a third-party block

**This changes the design.** ADR-0010's amendment says a holder narrows a token
"signed with the holder's own key". Biscuit's plain `appendBlock` does **not** do
that: appended blocks are signed with a next-key that travels *with the token*, so a
plain block attests to nothing about who wrote it.

The consequence is concrete. Every peer Alice calls receives her token. If delegation
were permitted by a bare fact, **any of those peers could append `delegate(itself)`
and use her authority.** T10-08 is that attack.

The fix is Biscuit's third-party blocks plus a scoped check. The hub mints:

```datalog
check if bound($k), connection_peer($k)
      or delegate($k), connection_peer($k) trusting ed25519/<alice-device-key>;
```

Only a block signed by Alice's device key can supply a trusted `delegate` fact.
T10-08 (thief, plain block) is refused; T10-09 (Alice-signed third-party block) is
accepted. **ADR-0010 should be amended to name the third-party block and the
`trusting` scope, because "the holder signs it" is not what plain attenuation does.**

### F4 — it loads in plain Node 24, contrary to the packaging

The package is a `wasm-pack --target bundler` build and imports
`./biscuit_bg.wasm` directly, which normally needs a bundler. Node 24 resolves it
with **no flag**, emitting `ExperimentalWarning: Importing WebAssembly module
instances is an experimental feature and might change at any time`. Working today on
an experimental loader path is worth knowing about; the recorded ADR-0019 concern
about the bundler target was, on this runtime, wrong.

### F5 — Biscuit predicates take at least one term

`audience_unrestricted()` is a parse error. The explicit-unrestricted state carries a
term: `audience_unrestricted(true)`.

### F6 — failure reports are richer than the tree's were

A denial names `block_id`, `check_id` and the rule text. That is finer-grained than
"which directory governed", which was the explainability the `.access` tree gave and
the thing ADR-0019 was most at risk of losing. It did not lose it.

---

## What this does **not** cover

- **No transport.** `connection_peer` is asserted by the test, not proven by a Noise
  handshake. Proto 01 establishes that the real proven identity reaches a handler;
  nothing here re-establishes it, and the join between the two is untested.
- **No hub process.** Minting is a function call. Invitation redemption, refresh and
  the `/.well-known` surface are all absent (block M remains DESIGNED).
- **No directory, no key rotation, no pinning.** `Biscuit.fromBase64` is handed a
  public key directly. ADR-0008's resolution seam and ADR-0018's pinned rotation
  chain are not exercised at all, so A-16, A-17 and A-22 remain unproven.
- **No audience *classes*.** Only audience by peer key (T10-13/14). The
  `audience_class` / `self_fact` path in §6.3 is written but untested.
- **No delegation depth.** Chained delegation is out of scope in ADR-0010 and no
  depth term is enforced here; a second third-party block was not attempted.
- **No revocation transport.** The deny list is a literal, not a pulled and cached
  snapshot. Proto 08 covers the pull; the two are not joined.
- **No performance claim.** ~0.2 ms per authorization after warm-up was observed
  incidentally on one machine. It is not a benchmark and no budget was derived from it.
