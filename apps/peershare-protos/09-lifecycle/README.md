# 09 — Do Stop, reload and Revoke behave as agreed?

`pnpm test 09-lifecycle`

**Answer: yes, after one fix.** Revoke did not work until the Sharer's access guard was
given the revocation registry.

```ts
revokeGuest(sharer, guestPeerId)      // members.remove + revocations.revoke
isSharerOffline(response): Promise<boolean>   // 502 with a kind in SHARER_OFFLINE_KINDS
SHARER_OFFLINE_KINDS                          // ["peer-unreachable", "stream-reset"]
```

## Measured, 2026-10-30

| Scenario | Result |
|---|---|
| Revoke, then the Guest's next request | refused (401/403) |
| Stop, then the Guest's next request | `502 {"kind":"peer-unreachable"}` in ~40 ms, never a hang; rarely `502 {"kind":"stream-reset"}` (finding 4) |
| The Sharer reloads with the same key and storage | same peer id; **the same Guest handle** is back in ~1.1 s, with no Invite |

## What the rung found

1. **Revoke was recorded and never enforced.** `withAccess` checks revocations only
   when given `revocation: hub.revocations`. Without it, a revoked Guest kept getting
   200 until its token expired. httpeers' conformance harness, the recipe this one
   follows, leaves it out too. Any hub host can make this mistake, so it is worth an
   httpeers default or a loud comment.
2. **Revoke is two writes**, as the hub's own `DELETE /admin/members/{peerId}` does:
   remove the member, and record the revocation.
3. **A reload must keep the private key and the hub storage** (IndexedDB in the page,
   decision 3.1). Then Guests reconnect on their own.
4. **"The Sharer is offline" has two faces.** Right after a Stop, a Guest's request
   almost always fails as `peer-unreachable`, but sometimes as `stream-reset`: the
   request goes out on the dying per-peer mux before the Guest sees that mux close, and
   it then fails as `PeerGoneError`, which the member reports as `stream-reset`. Both
   mean the Sharer is gone, so `isSharerOffline` accepts either kind
   (`SHARER_OFFLINE_KINDS`), with no retry (the human's decision on
   statewalker-sandbox#154). Measured 2026-11-16, the Stop test run 200 times in a loop: one
   run passed 200/200 with `peer-unreachable` ×199 and `stream-reset` ×1; a second
   passed 200/200 with `peer-unreachable` ×200 (slowest 38 ms).
