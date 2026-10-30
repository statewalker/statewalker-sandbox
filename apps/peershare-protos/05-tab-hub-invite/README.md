# 05 — Can a Sharer-hosted hub mint a one-time, 24 h Invite to all Services?

`pnpm test 05-tab-hub-invite`

**Answer: yes, with the published httpeers packages as they are.** The Sharer *is* the
hub of its own mesh (ADR 0001): one libp2p node runs `createHub` and `servePeer`, and
mounts the Services at `/s` with `extraMounts`. A Guest is a `startMember` holding an
Invite. The whole Way A pipeline runs for real in one process: Guest → relay/WebRTC →
Sharer → `/s` → the Bridge → Dirk's app.

`src/mesh.ts` is the harness every later mesh rung uses: `startRelay`, `startSharer`,
`startGuest`, `toSharer`, and `PEERSHARE_RULES`.

## Measured, 2026-10-30

| Scenario | Result |
|---|---|
| A redeemed Invite makes a Guest, who reaches Dirk's app through the mesh and the Bridge | ✓, response marked `relayed` |
| The same Invite a second time | refused; the hub says `redeemed` |
| A Guest asks for `/admin/members` | 403 from PeerShare's rules (with an allow-all policy it is 404, so the test measures the rule) |
| No Invite, no saved membership | the join fails |
| An Invite used more than 24 h after it was made | refused; the hub says `expired` |

## What the rung found

1. **The `guest` role is PeerShare's own.** `PEERSHARE_RULES` derives `peershare:view`
   from `role("guest")` and allows it on `/s/…` and `/.well-known/…` only.
2. **The pipeline test passed on its first run.** Its new code is wiring, not logic.
   The refusals above are what show it can fail.
3. **The Sharer's access guard must be given the revocation registry, and must serve
   limited connections.** Rungs 09 and 11 found these, and both are fixed in
   `src/mesh.ts`.
