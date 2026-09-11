# PROTOTYPE — a hub that relays signalling for its own members

**Throwaway.** It exists to answer one question and then be deleted, or have its one portable piece
(`hub-relay.ts`) folded into `src/`. The answer goes in `NOTES.md`.

## The question

The target design (umbrella note `notes/2026/2026-09/2026-09-11/httpeers-relay-reconnection.md`,
§7) has each hub run a circuit relay for its own members. Members reserve on the hub over their
WebRTC link to it, and reach each other through the hub instead of through the public relay. No
application traffic may cross the relay or a hub; when a direct WebRTC path is impossible, TURN
carries it. Three questions, checked in real browsers:

1. **Signalling only.** Does member A → hub → member B end as a *direct* WebRTC connection between
   A and B, with the hub's own connections carrying no more than signalling?
2. **Never through the hub.** With no direct path and no TURN, does the data fail loudly, not flow
   over the hub? With TURN, does it flow through TURN?
3. **Members only.** Does the membership gater refuse a non-member, both for reserving on the hub
   and for being relayed to a member?

## Run

```sh
pnpm --filter @statewalker/httpeers-stack proto:hub-relay
```

This needs Docker for the TURN server (`coturn/coturn:4.6`, host network, removed on exit). It
starts:

- the stack's own relay on a free port;
- a Vite build of `page/`, served on a free port;
- four headless Chromium pages: the hub, members A and B, and outsider C.

It then walks the three questions, printing each peer's connections and each browser's
`RTCPeerConnection` stats after every step.

The run is scripted rather than interactive: the behaviour in question is network behaviour, which
nothing can drive by keystroke.
