# 10 — Does the Guest come back after closing the tab, and not after Close session?

`pnpm test 10-guest-persistence`

**Answer: yes.** A Guest's saved identity is its private key. Reopening the link with the
key resumes the membership without the Invite. Close session forgets the key, after
which the link is spent.

```ts
joinOutcome(error): "invite-used" | "invite-expired" | "machine-offline"
```

## Measured, 2026-10-30

| Scenario | Result |
|---|---|
| Tab closed, link reopened, identity kept | `joinedBy: "resumed"`; Services reachable |
| Close session (identity forgotten), link reopened | `invite-used` |
| Link opened after 24 h | `invite-expired` |
| The Sharer is not running | `machine-offline` |

## What the rung found

**A used and an expired Invite are the same error**, `MemberJoinError("invitation-refused")`.
They are told apart only by the hub's answer quoted inside the message
(`{"error":"invitation already-redeemed"}` / `{"error":"invitation expired"}`). An offline
Sharer is a plain `Error` with relay status `NO_RESERVATION`. `joinOutcome` reads the
text, which is fragile.

**Proposal for httpeers-member:** carry the hub's refusal as a field
(`MemberJoinError.hubError`), and an offline hub as its own `reason`.

## Not answered here

Browser storage of the Guest identity (IndexedDB on the PeerShare origin) is
httpeers-member's `createSession`, already proven in httpeers-stack. What this rung
checks is the protocol: resume versus redeem.
