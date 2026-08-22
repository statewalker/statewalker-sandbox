# httpeers-stack

The installable reference deployment of the httpeers mesh design: a relay, a hub
peer, and two browser peers (an app page and an image peer) that discover and
call each other's services over the mesh.

## What it demonstrates

This stack exists to prove specific things rather than to be a product. Each
claim below is asserted by a test that fails when the claim stops being true —
several of them *were* false at some point during development, and were caught
precisely because a test could reach them.

- **HTTP semantics, addressed by peer id.** A peer is reached at
  `/{peerId}/path`. The calling code is a plain `fetch()` with no SDK, no client
  object and no error class to import. The page never handles a token: the
  ServiceWorker edge attaches it outbound, because a page that had to assemble a
  bearer header on every call would have an SDK — just an undocumented one.
- **A browser tab as a server.** The image provider is a page. It serves
  `GET /images/{id}` as a streamed body to another tab over WebRTC, and the
  consumer renders those bytes in an `<img>` — the browser's own image loader
  pulling from a peer, through a ServiceWorker, over a relay.
- **Discovery with nothing configured.** No peer id appears anywhere in the app
  page or its build config; both providers are resolved at runtime from the
  hub's mesh view, filtered by `kind`. Checked against the *built bundle*, not
  just the source, so a build-time injection would be caught.
- **Membership that can be withdrawn.** Revoking drops membership *and* records
  a revocation, so the token the peer is holding stops verifying on its next call
  rather than lasting until it expires. Measured at 2–8 ms end to end.
- **Authorization as data.** Tokens are Biscuits; policy is Datalog. The node
  asserts facts about itself and the request (`connection_peer`, `self_peer`,
  `time_ms`, `operation`, `resource`) and never reads them from the token.
  Nothing remote influences a decision.
- **Identity that survives a reload.** Each page keeps an Ed25519 key in
  IndexedDB and *resumes* its membership on the next run instead of redeeming a
  fresh invitation — invitations are single-use, so resume is the only way a
  returning page gets back in.

## The three processes

- **relay** (`src/relay/main.ts`) — a stock libp2p circuit-relay server. Every
  other peer, including the two browser pages, reaches the mesh through it.
  Listens on **port 9090**.
- **hub** (`src/hub/main.ts`) — the mesh's membership, presence, and
  invitation authority. Browser pages never dial it directly: they reach it
  over `/p2p-circuit/webrtc` through the relay, the same reservation the hub
  itself holds. It also binds a real TCP listener on **port 9091**, on
  `0.0.0.0` (every interface, not just loopback) — a fixed, knowable address
  for a same-host Node peer to dial directly. **On a server this is a
  wildcard bind**: it is reachable from the network, not just from
  `localhost`, so put it behind a firewall or a private network the same way
  you would the relay if you don't want it reachable from outside.
- **static server** (`src/static-server/main.ts`) — serves the two browser
  pages and `httpeers.json` (the invitation payload) over plain HTTP, one
  origin per page:
  - **port 5175** — the app page (`src/pages/app`)
  - **port 5176** — the image peer page (`src/pages/image-peer`)
  - **port 5177** — the hub page (`src/pages/hub`), see below

`scripts/start.sh` boots all three, in that order, and tears all three down
together on Ctrl-C.

## Running it

```bash
pnpm install
pnpm bootstrap
pnpm start
```

`pnpm bootstrap` (`src/setup/main.ts`) turns a fresh checkout into a runnable
stack: it generates (or, on a later run, reads back) this deployment's
persistent Ed25519 identity keys at `.httpeers/{relay,hub}.key`, and writes
`httpeers.json` — `{ relayAddrs, hubPeerId }`, the invitation payload both
daemons and both browser pages read to find the mesh. Running it again does
not rotate the keys or change `httpeers.json`: it is idempotent, by design —
the hub's peerId *is* the mesh identity, and regenerating it would silently
invalidate every issued token.

**The script is named `bootstrap`, not `setup`.** `pnpm setup` is a pnpm
built-in command — it configures the user's shell environment — and a
built-in always wins over a package script of the same name. A `"setup"`
script in `package.json` would never run via `pnpm setup`; pnpm would print
"No changes to the environment were made", exit 0, and generate nothing
(and, on a fresh machine, edit the user's shell profile). `pnpm bootstrap`
is not a pnpm command, so it reaches the script.

Once both commands have run, open:

- `http://127.0.0.1:5175/` — the app page
- `http://127.0.0.1:5176/` — the image peer page

Each page needs an invitation id to join the mesh, passed as a `?invite=`
query parameter (e.g. `http://127.0.0.1:5175/?invite=<id>`), or typed into
the page's own paste-in form if the query parameter is absent.

**There is currently no operator-reachable way to mint one.** Invitations
are minted by `InvitationStore.create(id, roles, ttlMs)`
(`src/hub/persist.ts`), but nothing in `src/` outside the test suite ever
calls it — only tests do. `GET /admin/invitations` does not list issued
invitations either, despite its name and its own comment saying
"listing only": it currently returns only `{ ok, issuedBy, caller }`, no
invitation data. Joining a running `pnpm start` deployment as a real
operator needs one of these to be built: a `POST /admin/invitations`
endpoint on the hub, or a small script that shares the hub's persistent
state file and calls `InvitationStore.create` directly. Until then, the
only way to get an invitation id is through a test (e.g.
`tests/e2e/harness.ts`), not through this deployment as it stands.

## The hub in a browser page

`http://127.0.0.1:5177/` is a **second implementation of the hub**, running in
a tab. It is not a replacement: the Node hub above is still the default way
this stack comes up, and `pnpm bootstrap` / `pnpm start` / the e2e suites are
unchanged. What the page demonstrates is that the hub's whole HTTP surface
(`src/hub/endpoints.ts`) is genuinely transport-neutral — the same
`createHubEndpoints`, the same vocabulary and `.access` tree, the same state
logic over the same `SnapshotStore` seam, in a browser. Search moves with it:
whoever is the hub advertises and serves `/search`, so the app page discovers
it by `kind` exactly as before and needs no change.

The page does three things:

- **Mints invitations on demand.** A button per target page, pressed whenever
  another page needs to join. Each press produces a *new* single-use code —
  a redeemed one fails every later attempt with `already-redeemed`, so every
  page needs its own. Each row shows the id, its roles, whether it is still
  unspent (asked of the hub's own spent-id set, so the panel cannot claim a
  code is usable when the hub would refuse it), the **blob**, and a link.
- **Lists members, separating saved from active.** *Saved* is membership,
  from the persisted snapshot; it survives a reload. *Active* is presence,
  from heartbeats; it expires on a TTL. Both come from `buildMeshView` — the
  same projection `GET /.well-known/mesh` serves every remote peer — rather
  than from a second notion computed in the page.
- **Revokes a membership.** Removal is two things: it drops membership *and*
  revokes the peer's tokens, so the token it is holding right now stops
  working on its next call instead of lasting until it expires. The page
  reports the new policy version, which is the evidence that the second half
  happened.

Three things differ from the Node hub, and they are the whole of the
difference:

- **Where the key is kept.** This origin's IndexedDB, in the same protobuf
  encoding `pnpm bootstrap` writes to `.httpeers/hub.key`, reused on every
  reload. That is not optional: the hub's peerId *is* the mesh (every token's
  `mesh` claim restates it), so a fresh key per reload would silently
  invalidate every token ever issued.
- **Where the state is kept.** The same IndexedDB — members and spent
  invitation ids, written through a store whose in-memory copy stays
  authoritative so `SnapshotStore.write` can remain synchronous.
- **How a joining page is told the mesh's name.** It cannot come from
  `httpeers.json`: that file is written at bootstrap, from a key file, and
  this hub's identity is created in a tab afterwards. So the page mints a
  single-use invitation and renders a complete **join link** carrying
  `relayAddrs`, its own `hubPeerId`, and that invitation id. Open the link, or
  paste it into the target page's join box. One link admits exactly one page —
  invitations are single-use, so mint one per page rather than sharing one.

The app and image-peer pages accept both forms: a bare `?invite=<id>` still
means "the mesh `httpeers.json` names" (the Node hub), and a `?join=<blob>`
link means "the mesh this blob names" (a hub page).

**Reset.** The page's reset control destroys the stored identity *and* the
member list. That does not rotate a credential — it founds a different mesh:
every token stops verifying and every link handed out stops working. The
confirmation says so.

```bash
pnpm build:hub-page   # -> dist/hub, served on 5177 by pnpm start
pnpm dev:hub-page     # vite dev server, same port
```

## Stopping it

Ctrl-C (or `SIGTERM` to `scripts/start.sh`'s process group) tears down the
relay, hub, and static server together — `start.sh` traps the signal, kills
every child, and removes the hub's ready-marker file so the next run doesn't
read a stale one. No manual cleanup should ever be necessary; if a process
is still around afterwards, that's a bug, not routine.

## Tests

```bash
pnpm test        # typecheck + vitest, including the node and browser e2e suites
pnpm typecheck
```

## Architecture

The whole system rests on one type. Everything above the transport is
`(req: Request) => Promise<Response>` — the router, the policy middleware, the
services and the ServiceWorker edge all speak it, which is why the same handler
runs in Node and in a browser tab with no wrapper.

**`@statewalker/httpeers.core`** is transport, routing, binding, policy, tokens
and revocation. It imports libp2p in exactly two files — `tokens.ts` and
`transport-duplex.ts` — so everything else is portable. That is what lets the
hub's entire HTTP surface run unchanged inside a browser tab.

That invariant is currently **checked by hand**, not by a test:

```bash
grep -rlE "^import.*libp2p" packages/httpeers.core/src/
```

It should list those two files and nothing else. Worth turning into a test —
the property is load-bearing (a browser bundle carrying a stray libp2p import
dies on its first line, which is how two such imports were found during
development) and nothing currently fails if it regresses.

**This application** is the hub's endpoints, the two services, the three pages
and the policy. A service is a handler, a policy naming a capability, and an
advertisement, deliberately kept together — so relocating one is a change of
wiring rather than of code. That is why moving search from the Node hub into the
hub page required no change in the app page at all.

**How a page reaches a peer.** A page's `fetch()` hits its own ServiceWorker,
which proxies to the peer's router running *in the page*. The router strips the
mount prefix, reads the first path segment, and either serves locally or dials
the named peer. All application code — and therefore all token verification —
runs in the page; the worker only carries bytes.

## Technology

| Layer | Choice | Why |
|---|---|---|
| Transport | `libp2p 3.3.8`, pinned exact | WebSockets to the relay, circuit-relay v2 for reservations, WebRTC browser-to-browser, TCP for host peers. No carets; gossipsub deliberately absent. |
| HTTP over streams | `webrun-http-streams` | Encodes a `Request`/`Response` pair over any duplex byte stream, streaming both directions. |
| Browser edge | `webrun-http-browser` | A ServiceWorker adapter that makes a page's own `fetch()` reach a handler running in that page. |
| Tokens | Biscuit `0.6.0` (wasm) | Public-key verified, offline attenuation, Datalog authorizer. Replaced a hand-rolled compact JWS. |
| Policy | Datalog rules | Replaced a walked `.access` tree plus a role vocabulary — five mechanisms collapsed into one. |
| Build & test | Vite 8, Vitest, Playwright, Turbo | Three page bundles; suites that boot real relays and hubs on real ports; browser legs in Chromium and Firefox. |

**The security model, briefly.** The hub mints a Biscuit carrying the holder's
identity, its roles, an expiry, a binding to the key it will prove, and
optionally an audience. The receiving peer parses it against the mesh's public
key, asserts facts about itself and the request, and runs the token's checks
plus its own policy under a bounded authorizer. A refusal says which condition
failed and whether retrying could help: `401` means a refresh might work, `403`
means it will not.

## Attention points

Three properties below are **deliberate design choices**, not defects — recorded
here with the reasoning, and with the residual risk each one leaves, so a later
reader can re-open the decision on evidence rather than rediscover it as a
surprise. The section after this one lists actual gaps.

### The relay is open and unauthenticated

**The choice.** Anyone who can reach the relay can reserve through it, and that
is the point: an open relay lets anyone stand up a mesh without asking
permission, which is what makes anonymous meshes possible. **The security layer
lives on the hub**, not on the relay — a relayed connection still has to redeem
an invitation, present a Biscuit bound to the key it proves, and satisfy the
destination's policy. Relaying someone's bytes grants nothing.

**Residual risk, accepted.** Resource exhaustion: reservations, connections and
bandwidth are finite, and nothing rate-limits a stranger. With no real users this
is not a pressing problem, and circuit-relay v2's own reservation and data limits
(128 KB / 2 min per circuit by default) blunt the worst of it.

**Two risks that are not overload**, worth knowing before a public deployment:

- **The relay operator sees the topology.** Stream contents are encrypted end to
  end by Noise, so the relay learns nothing of what is said — but it necessarily
  learns *who talks to whom, when, and how much*. For a mesh whose selling point
  is anonymity, the relay is a global observer of the peer graph. Running your
  own relay does not fix this for your users; it relocates it to you.
- **Third parties can use your infrastructure.** An open relay will carry traffic
  for meshes that have nothing to do with yours, including traffic you would not
  want associated with your host. That is a reputational and operational exposure
  rather than a mesh-security one, and it is the usual reason open relays end up
  gated eventually.

### The hub is a single point of failure

**The choice.** Simplicity, deliberately, at this stage. One hub mints every
token and owns membership, presence and roles. The alternative — a mesh
identified by a shared key, with several interchangeable managers — is more
flexible and considerably more complex: it requires those managers to agree on
membership, presence and roles, which is a replication and convergence problem,
not a signature change.

**What already softens it.** Verification is offline: a peer checks a token
against the mesh's public key and its own rules, never calling the hub. So while
the hub is down, **existing peers keep working until their tokens expire** —
only joining, resuming and revocation need it. The mesh does not stop; it stops
*changing*.

**What it costs.** No key rotation story, and revocation is the hard part of any
future multi-hub design: adding a member can converge lazily, but *removing* one
must not.

**A note on the distance to the alternative.** It is smaller than it looks in one
respect: the mesh id is *already* a public key — `claims.mesh === claims.iss`,
the hub's own peer id — so the addressing model does not change. What is missing
is multiple signers and agreement between them. Biscuit's offline attenuation
and third-party blocks are relevant here: they let a holder narrow a token, and
let a second key vouch for something, without either party talking to the other.

### The pages need HTTPS off localhost

**Not a gap — the intended deployment model.** Every publicly reachable member
(relay, hub, and the page origins) is expected to be served over TLS. The design
already provides for it: Node terminates TLS itself via `TLS_CERT`/`TLS_KEY`,
with no reverse proxy, and the relay's server address is
`/dns4/host/tcp/443/wss`.

**The constraint to plan around** is that this is all-or-nothing, because it is
enforced by the browser rather than by us: ServiceWorkers require a secure
context, so the pages simply do not start off `localhost` over plain HTTP; and
mixed-content rules mean an `https://` page cannot dial a `ws://` relay. So the
page origin, the relay and the hub all have to be TLS together. What remains
unbuilt is the certificate story — issuance and renewal — not the architecture.

## Remaining gaps

Unbuilt or unresolved, as distinct from the deliberate choices above. None is
hidden by a passing test — several are *pinned* by tests asserting the current,
limited behaviour so it cannot drift silently.

**Hardening**

- **Nothing is least-privileged yet.** Audience is expressible and enforced by
  the destination, but the join protocol still mints unrestricted tokens, so in
  practice a member's token is valid at every peer. Narrowing invitation and
  presence tokens is a protocol design question, not a signature change.
- **No body-size bound.** On a runtime lacking request streams, a peer can make a
  server buffer a whole upload before the handler runs; two of the four buffering
  entry points are peer-driven.
- **No hop limit on forwarding.** Forwarding is deny-by-default and no peer here
  relays, so it is inert — but it is a precondition for shipping one that does.

**Operational**

- **Fixture data sits behind a one-function seam** in both services, so a real
  backend swaps in without touching a handler. That seam is the intended
  extension point.
- **Payload and runtime caveats.** The Biscuit wasm is 2.35 MB per origin across
  three origins, and Node's wasm-module import is still flagged experimental —
  the relay, hub and setup processes all rely on it.
- **Known open defects.** A generator-cancellation leak in `webrun-http-streams`
  costs one mux stream slot per call and needs an API change to fix properly.
- **Two load-sensitive tests, neither a correctness problem.** `peer.test.ts`'s
  D8 fires 20 concurrent requests over one connection and asserts none of them
  cross-wires identity. Under heavy CPU contention it has thrown
  `StreamResetError` from yamux's window handling — a transport-level reset that
  aborts the run *before* the assertion, so **no run has ever shown a crossed
  identity**. Measured 1–2 failures in 8 while several browser suites were
  running concurrently; **10 of 10 passes on an idle machine**. The browser
  streaming assertion degrades the same way — proven ~55× slower under 3×
  oversubscription. Both are worth a bound or a retry policy if this ever runs on
  shared CI; neither indicates a defect in the mesh.

If you take one thing from these two sections: the architecture is further along
than the operations. The library boundary is clean, the policy layer is data, and
the browser and Node hubs are genuinely interchangeable. The three attention
points above are settled choices with known costs, not open questions — what is
genuinely unbuilt is smaller: certificate issuance, a body-size bound, and
narrowing the tokens the join protocol mints.
