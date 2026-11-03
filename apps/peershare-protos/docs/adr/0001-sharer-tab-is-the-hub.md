# The Sharer's tab is the hub of its own mesh

Every Sharer runs `createHub` (with `idbStorage`) inside the PeerShare page, next to its
own member. Invitations are minted, redeemed and revoked there; the only shared
infrastructure is the public relay. We chose this over one hosted SandClaw hub for
all Sharers because it keeps the trust model to "Dirk decides who sees Dirk's
services" — no operator can admit a Guest, and nothing about a share is stored
off the Sharer's machine.

## Consequences

- Sharing exists only while the tab is open; the page says so. Guests see the
  "machine offline" outcome otherwise, and reconnect when the tab returns.
- The Sharer's identity and hub state must survive reloads (IndexedDB), or every
  Guest would need a new Invite after a refresh.
- The Sharer's link to the relay must be direct-capable: a member in "relay" link
  mode is unreachable by others (`hubLink()`), so the page has to detect and
  report it.
- A later "always on" mode (the Bridge as a full Node member) is a new ADR, not a
  tweak: it moves the hub off the tab.
