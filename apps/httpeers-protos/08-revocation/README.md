# 08 — Revocation as a pulled, cached deny list

`pnpm demo:08-revocation`

Pure logic with an **injected clock**, so the timing is exact and the demo is
deterministic rather than sleeping for real seconds. **This is a
reconstruction** (see Provenance).

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | A freshly minted token is accepted | `cache.check(token)` returns null before any change | — |
| 2 | Removing a member does **not** invalidate the token cryptographically | After `hub.remove`, the token is still unexpired and well-formed; the provider with a stale cache still accepts it | This step is skipped — it is the window the design exists to close |
| 3 | The hub's **policy counter moves** on a change | `policyVersion()` differs from the cache's known version | A change is invisible to peers |
| 4 | The provider pulls the change list **only because the counter moved** | `heartbeat()` returns true, having compared versions | It pulls unconditionally, putting the hub on the request path |
| 5 | After the pull, the token is **refused with a reason** | `check()` returns `"member removed"` | It is still accepted |
| 6 | Worst-case exposure is **one heartbeat**, not the full TTL | Token TTL 30 s, heartbeat 5 s; refusal lands at t+6 s | Exposure scales with TTL |
| 7 | **Re-admission works** — a token minted *after* the change is accepted | New token's `iat` exceeds the recorded `changedAt`, so `check()` returns null | Revocation is permanent per peer |
| 8 | A quiet period causes **no pull at all** | With the counter unchanged, `heartbeat()` returns false | The hub is polled needlessly, defeating the design |

Exit code requires 5, 7 and 8 to all hold.

## Why `iat` is load-bearing

Without an issued-at claim, revocation is all-or-nothing: there is no way to
distinguish a token minted before a role change from one minted after, so a
removed member can never be re-admitted without changing their identity. Claim 7
is what that field buys, and it is why it was added.

The shape matters too. The heartbeat a peer already sends carries the version,
so the common case — nothing changed — costs nothing extra, and the hub is
never consulted during a request. Claims 4 and 8 are the two halves of that.

## Provenance

The archived prototype (`35-httpeers-prototype-v0.8.0`) was saved as a
**delta**; the tree it applied to no longer exists in the archive.
`lib/revocation.ts` implements the same mechanism from the recorded findings.
The original reported a measured latency of one heartbeat, which claim 6
reproduces structurally with an injected clock.

## Not covered here

- **No signatures.** Tokens are plain objects; minting, signing and verifying
  are not exercised. This demo is about the revocation window, not crypto.
- **No network.** Hub and provider are in-process; the heartbeat is a function
  call rather than an HTTP request.
- **The hub itself is irrevocable** — a known open problem in the design, and
  not addressed here.
- **No cache eviction.** The deny list grows monotonically; nothing prunes
  entries for peers whose tokens have all expired.
