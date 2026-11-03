# 09 — Do Stop, reload and Revoke behave as agreed?

`pnpm test 09-lifecycle`

**Answer: yes, after one fix.** Revoke did not work until the Sharer's access guard was
given the revocation registry.

```ts
revokeGuest(sharer, guestPeerId)      // members.remove + revocations.revoke
isSharerOffline(response): Promise<boolean>
```

## Measured, 2026-10-30

| Scenario | Result |
|---|---|
| Revoke, then the Guest's next request | refused (401/403) |
| Stop, then the Guest's next request | `502 {"kind":"peer-unreachable"}` in ~40 ms, never a hang |
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
