# 11 — What happens when a Guest cannot reach the Sharer directly?

`pnpm test 11-relay-only-sharer`

**Answer: it works, after one fix, as long as the relay has httpeers' limits.** A Guest
whose WebRTC upgrade fails falls back to a *relay link*, and all its traffic crosses the
public relay. (Simulated by building the Sharer without WebRTC, as httpeers' own tests
do.)

## Measured, 2026-10-30

| Scenario | Result |
|---|---|
| A Guest on a relay link joins, sees `hubLink() === "relay"`, and reaches the catalog | ✓ (after the fix) |
| A 1 MiB page over a relay link, relay with httpeers' limits (1 GiB, 6 h) | arrives whole |
| **Relay fact:** the same page, stock libp2p relay (128 KiB per relayed connection) | cut off |

## What the rung found

1. **The Sharer refused relay-link Guests outright.** libp2p marks a relay circuit
   "limited", and `servePeer` does not serve limited connections unless told to, so the
   join itself failed (`stream reset`). PeerShare's Sharer always sets
   `serveOnLimitedConnection: true`.
2. **The relay's limits are part of the product.** A web app does not fit in 128 KiB.
   PeerShare must use a relay configured like `httpeers/apps/relay` (or its own), and
   relay-link traffic is bandwidth the relay operator pays for.
3. **The Sharer should show relay-link Guests** as "connected through the relay
   (slower)". The UI stories carry that state.
