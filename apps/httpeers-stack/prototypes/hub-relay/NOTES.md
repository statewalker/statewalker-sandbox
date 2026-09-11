# NOTES — what the hub-relay prototype answered (2026-09-11)

The question is in `README.md`. Everything below was observed in **headless Chromium**, in five runs
of `pnpm proto:hub-relay`, all on one host:

- the stack's own relay (libp2p 3.3.8, circuit-relay-v2 4.2.11, `@libp2p/webrtc` 6.0.29);
- a local `coturn/coturn:4.6` on the LAN address;
- four browser contexts: the hub, members A and B, and outsider C.

Firefox was not run.

## Verdict: the design holds

**Q1. Does the hub carry only signalling? Yes.**
- A → `/p2p/<hub>/p2p-circuit/webrtc/p2p/<B>` ends as an **unlimited, direct WebRTC connection**
  between A and B.
- 4 MiB crossed it: B counted 4,194,304 bytes, and A's A–B `RTCPeerConnection` sent about 4.4 MB,
  host/host.
- The hub's own `RTCPeerConnection` byte counters were **identical before and after** the transfer.
  The hub moved nothing.

**Q2. Does data ever go through the hub? No, and libp2p enforces it. With TURN, it goes through TURN.**
- *No direct path, no TURN* (`iceTransportPolicy: "relay"`, no ICE servers):
  - the WebRTC dial times out;
  - a bare circuit through the hub opens, but it is **limited**;
  - opening the application protocol on it throws `LimitedConnectionError`.
- *The same, with TURN available:* the connection comes up with the selected candidate pair
  **relay/relay**, and 4 MiB arrives.
  - In the two runs whose hub counters I compared, they were unchanged in one and rose by about
    2.6 KB in the other. That is the connection monitor's 10 s pings on the hub's links, not the
    data.
  - **In 1 of 5 runs the TURN-only dial timed out instead.** Unexplained: coturn logged allocations
    and no errors. Look at this before relying on TURN as the only path; the suspect is the WebRTC
    dial timeout against the time ICE takes over TURN.

**Q3. Are non-members refused? Yes.**
- C, connected to the hub over WebRTC, is refused a reservation on it.
- Asking the hub to relay C to member B fails with `PERMISSION_DENIED`.
- **Control:** the moment the hub admits C, the same reservation succeeds and C → B through the hub
  connects. The only variable is membership.
- Note that C can still *connect* to the hub. That is intended: a non-member must reach the hub to
  redeem an invitation.

## Findings the real implementation must handle

1. **A member must close its limited signalling circuit to the hub once WebRTC is up.**
   circuit-relay-v2 relays through `connectionManager.getConnections(relay)[0]`, the *first*
   connection to the relay whether it is limited or not. A member's first connection to its hub is
   the limited circuit through the public relay used for the SDP exchange. While that is still open,
   every dial *through* the hub fails with `LimitedConnectionError`. The prototype's `dropLimited`
   is the fix.
2. **Forcing a limited connection truncates silently.** With `runOnLimitedConnection: true` on both
   sides, B received **114,688 of 1,048,576 bytes** and the sender reported success. That is the
   hub's default 128 KiB circuit cap: exactly the "gallery breaks halfway" failure shape. Nothing in
   httpeers may set that flag for application protocols. Today nothing does, and it should stay that
   way deliberately.
3. **A reservation on the hub yields a double-circuit address**
   (`<relay>/p2p-circuit/webrtc/p2p/<hub>/p2p-circuit/p2p/<member>`). Nothing should dial those. The
   mesh view should compose `/p2p/<hub>/p2p-circuit/webrtc/p2p/<member>`, which works because the
   circuit transport reuses the existing connection to the hub.
4. **Reserving on the hub means listening on `/p2p/<hub>/p2p-circuit`**, through
   `node.components.transportManager.listen`. That is a *configured* relay: libp2p will not restore
   it if the hub link drops, so `superviseRelay` (statewalker-sandbox#3) needs to cover the hub
   reservation as well.
5. **Members keep their WebSocket to the public relay** after reaching the hub, even though they hold
   no reservation there. Step 3 (members drop public reservations) should close it once the hub link
   is up.
6. **Signalling circuits between members linger.** After A → B upgraded to WebRTC, A still held the
   limited circuit to B through the hub. The hub's 2-minute circuit limit ends it eventually, but
   closing it right after the upgrade is cleaner, for the same reason as finding 1.

## What to keep

- `hub-relay.ts`: `membershipGater` and `hubRelayServer`. It is small, and it is the whole of the hub
  side.
- Findings 1, 2, 4 and 5 become requirements for step 3.
- The rest of this directory (`page/`, `run.ts`, the `proto:hub-relay` script) is throwaway. Delete
  it when step 3 absorbs `hub-relay.ts`.
