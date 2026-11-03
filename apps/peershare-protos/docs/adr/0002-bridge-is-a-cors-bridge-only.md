# The downloadable Bridge only relays loopback HTTP; it is not a mesh member

"Way A" ships a Bun-compiled executable. It listens on `127.0.0.1`, relays the
PeerShare page's requests to local Services and adds the cross-origin headers the
page needs. The page stays the only mesh member, so Way A and Way B (the service
allows cross-origin calls itself) run the same page code and differ only in the
Upstream's base URL.

We rejected making the executable a full Node member (`startMember`), which would
keep shares alive with the tab closed, because it would split the app into two
implementations of hub, invites and UI state, and put identity keys in a second
place.

## Consequences

A loopback port that answers cross-origin requests is reachable by every website
the Sharer visits, so the Bridge is locked down:

- binds `127.0.0.1` only;
- sends `Access-Control-Allow-Origin` for the PeerShare origin only
  (`https://tools.sandclaw.ai`, configurable);
- refuses every request without the Pairing token it generated at launch and passed
  in the URL fragment (`#localUrl=…&t=…`);
- relays to loopback and private-network targets only, by default.

Chromium asks the user for "Local Network Access" the first time a public `https`
page calls loopback; the page explains that prompt before it appears.
