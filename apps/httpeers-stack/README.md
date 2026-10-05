# httpeers-stack

## What it is

The installable reference deployment of the httpeers mesh: a relay, a hub peer, and browser
peers (an app page, an image peer, a hub page and a proxy page) that discover and call each
other's services over the mesh. Private; not published.

Each property below is asserted by a test that fails when the property stops being true:

- **HTTP semantics, addressed by peer id.** A peer is reached at `/{peerId}/path`. The calling
  code is a plain `fetch()` with no SDK, no client object and no error class to import. The page
  never handles a token: the ServiceWorker edge attaches it outbound, because a page that had to
  assemble a bearer header on every call would have an SDK, just an undocumented one.
- **A browser tab as a server.** The image provider is a page. It serves `GET /images/{id}` as a
  streamed body to another tab over WebRTC, and the consumer renders those bytes in an `<img>`:
  the browser's own image loader pulling from a peer, through a ServiceWorker, over a relay.
- **Discovery with nothing configured.** No peer id appears anywhere in the app page or its build
  config; both providers are resolved at runtime from the hub's mesh view, filtered by `kind`.
  This is checked against the built bundle, not just the source, so a build-time injection would
  be caught.
- **Membership that can be withdrawn.** Revoking drops membership *and* records a revocation, so
  the token the peer is holding stops verifying on its next call rather than lasting until it
  expires. Measured at 2–8 ms end to end.
- **Authorization as data.** Tokens are Biscuits; policy is Datalog. The node asserts facts about
  itself and the request (`connection_peer`, `self_peer`, `time_ms`, `operation`, `resource`) and
  never reads them from the token. Nothing remote influences a decision.
- **Identity that survives a reload.** Each page keeps an Ed25519 key in IndexedDB and *resumes*
  its membership on the next run instead of redeeming a fresh invitation. Invitations are
  single-use, so resume is the only way a returning page gets back in.

## The shape: three processes and four pages

```
 browser pages (one origin each)            Node processes
 ┌──────────────┐  ┌──────────────┐
 │ app   :5175  │  │ image  :5176 │──┐     ┌──────────────┐   ┌──────────────────┐
 └──────────────┘  └──────────────┘  ├──ws─│ relay  :9090 │───│ hub  tcp :9091    │
 ┌──────────────┐  ┌──────────────┐  │     └──────────────┘   └──────────────────┘
 │ hub page:5177│  │ proxy  :5178 │──┘     static server: serves dist/{app,image-peer,hub}
 └──────────────┘  └──────────────┘                         and httpeers.json
```

- **relay** (`src/relay/main.ts`): a stock libp2p circuit-relay server on **port 9090**. Every
  other peer, including the browser pages, reaches the mesh through it.
- **hub** (`src/hub/main.ts`): the mesh's membership, presence and invitation authority. Browser
  pages never dial it directly: they reach it over `/p2p-circuit/webrtc` through the relay, the
  same reservation the hub itself holds. It also binds a TCP listener on **port 9091** on
  `0.0.0.0`, a fixed address for a same-host Node peer to dial directly.
- **static server** (`src/static-server/main.ts`): serves the built pages and `httpeers.json`
  (the invitation payload) over HTTP, one origin per page: **5175** app (`src/pages/app`),
  **5176** image peer (`src/pages/image-peer`), **5177** hub page (`src/pages/hub`). The ports
  are fixed in `src/ports.ts`, not configurable: each page needs its own origin, and a link one
  page hands another must name a port both agree on without being told.
- **proxy page** (`src/pages/proxy`, port **5178**): offers external HTTP APIs to the mesh as a
  resource (`src/services/proxy.ts`). It runs only through its own Vite scripts (`dev:proxy`,
  `build:proxy`); `pnpm start` does not serve it.

`scripts/start.sh` builds the app, image-peer and hub pages, then boots relay, hub and static
server in that order, and tears all three down together on Ctrl-C.

## How to run it

1. `pnpm install` at the repo root.
2. `pnpm bootstrap` in this folder. It runs `src/setup/main.ts`, which generates (or, on later
   runs, reads back) the deployment's persistent Ed25519 keys at `.httpeers/{relay,hub}.key` and
   writes `httpeers.json` (`{ relayAddrs, hubPeerId }`), which the daemons and the pages read to
   find the mesh.
3. `pnpm start`. When the hub is up it prints three join URLs, each carrying a fresh single-use
   invitation valid for 30 minutes:

   ```
   join URLs (one invitation each, single-use, valid 30 min):
     app page          http://127.0.0.1:5175/?invite=<id>
     app page as admin http://127.0.0.1:5175/?invite=<id>
     image peer        http://127.0.0.1:5176/?invite=<id>
   ```

4. Open the image peer URL first, then an app page URL. The app page discovers the image peer
   through the hub, so a provider that has not joined yet shows as absent rather than broken.
   A page opened without `?invite=` shows a paste-in form instead.
5. Ctrl-C (or `SIGTERM` to `start.sh`'s process group) stops the relay, hub and static server
   together. `start.sh` traps the signal, kills every child and removes the hub's ready-marker
   file (`.httpeers/hub-ready`) so the next run does not read a stale one. If a process is still
   around afterwards, that is a bug.

### The hub page: the same hub in a tab

`http://127.0.0.1:5177/` is a second implementation of the hub, running in a tab. The Node hub is
still how the stack comes up. The page shows that the hub's whole HTTP surface
(`src/hub/endpoints.ts`) is transport-neutral: the same `createHubEndpoints`, the same rules,
the same state logic over the same `SnapshotStore` seam, in a browser. Search moves with it:
whoever is the hub advertises and serves `/search`, so the app page discovers it by `kind` and
needs no change.

The page:

- **Mints invitations on demand.** One button per target page. Each press produces a new
  single-use code; a redeemed one fails every later attempt with `already-redeemed`, so every
  page needs its own. Each row shows the id, its roles, whether it is still unspent (asked of the
  hub's own spent-id set), the blob and a link.
- **Lists members, separating saved from active.** *Saved* is membership, from the persisted
  snapshot; it survives a reload. *Active* is presence, from heartbeats; it expires on a TTL. Both
  come from `buildMeshView`, the same projection `GET /.well-known/mesh` serves every remote peer.
- **Revokes a membership.** It drops membership *and* revokes the peer's tokens, and reports the
  new policy version as evidence that the second half happened.

It differs from the Node hub in three places:

- **Where the key is kept.** This origin's IndexedDB, in the same protobuf encoding
  `pnpm bootstrap` writes to `.httpeers/hub.key`, reused on every reload. The hub's peerId *is*
  the mesh (every token's `mesh` claim restates it), so a fresh key per reload would invalidate
  every token ever issued.
- **Where the state is kept.** The same IndexedDB: members and spent invitation ids, written
  through a store whose in-memory copy stays authoritative so `SnapshotStore.write` can stay
  synchronous.
- **How a joining page learns the mesh's name.** Not from `httpeers.json`, which names the Node
  hub. The page renders a complete **join link** carrying `relayAddrs`, its own `hubPeerId` and a
  single-use invitation id. The app and image-peer pages accept both forms: `?invite=<id>` means
  "the mesh `httpeers.json` names", `?join=<blob>` means "the mesh this blob names".

**Reset** destroys the stored identity *and* the member list. That founds a different mesh:
every token stops verifying and every link handed out stops working. The confirmation says so.

## Why it is the way it is

### One type above the transport

Everything above the transport is `(req: Request) => Promise<Response>`: the router, the policy
middleware, the services and the ServiceWorker edge all speak it, so the same handler runs in Node
and in a browser tab with no wrapper.

`@statewalker/httpeers.core` is transport, routing, binding, policy, tokens and revocation. It
imports libp2p in exactly two files, `tokens.ts` (key types only) and `transport-duplex.ts`, so
everything else is portable. That is what lets the hub's HTTP surface run unchanged in a tab. The
invariant is checked by hand, not by a test:

```bash
grep -rlE "^import.*libp2p" packages/httpeers.core/src/   # from the repo root
```

It must list those two files and nothing else. A browser bundle carrying a stray libp2p import
dies on its first line.

This app is the hub's endpoints, the services, the pages and the policy. A service is a handler,
a policy naming a capability, and an advertisement, kept together so that relocating one is a
change of wiring rather than of code. That is why search can live in either hub with no change to
the app page.

**How a page reaches a peer.** A page's `fetch()` hits its own ServiceWorker, which proxies to the
peer's router running *in the page*. The router strips the mount prefix, reads the first path
segment, and either serves locally or dials the named peer. All application code, and therefore
all token verification, runs in the page; the worker only carries bytes.

### Keys are persistent, and `bootstrap` is idempotent

Running `pnpm bootstrap` again does not rotate the keys or change `httpeers.json`. The hub's
peerId *is* the mesh identity; regenerating it would invalidate every issued token.

The script is named `bootstrap`, not `setup`: `pnpm setup` is a pnpm built-in (it configures the
user's shell environment) and wins over a package script of the same name. It would print
"No changes to the environment were made", exit 0 and generate nothing.

### Invitations are minted inside the hub process

Pending invitations live only in the hub's memory; only *spent* ids reach the persisted snapshot,
which the hub reads once at start. A second process could not mint an invitation this hub would
honour (the join would fail `not-found`), so the hub prints the join URLs itself.

### The relay is open and unauthenticated

Anyone who can reach the relay can reserve through it. That lets anyone stand up a mesh without
asking permission. The security layer lives on the hub: a relayed connection still has to redeem
an invitation, present a Biscuit bound to the key it proves, and satisfy the destination's policy.
Relaying someone's bytes grants nothing.

The costs: nothing rate-limits a stranger (circuit-relay v2's defaults, 128 KB / 2 min per
circuit, blunt the worst of it); the relay operator sees *who talks to whom, when and how much*,
though Noise hides the contents; and an open relay will carry traffic for unrelated meshes.

### The hub is a single point of failure

One hub mints every token and owns membership, presence and roles. Several interchangeable hubs
would need to agree on membership, presence and roles, a replication problem rather than a
signature change. Verification is offline: a peer checks a token against the mesh's public key
and its own rules without calling the hub. While the hub is down, existing peers keep working
until their tokens expire; only joining, resuming and revocation need it. There is no key
rotation. The mesh id is already a public key (`claims.mesh === claims.iss`, the hub's peer id).

### Tokens and refusals

The hub mints a Biscuit carrying the holder's identity, roles, an expiry, a binding to the key it
will prove, and optionally an audience. The receiving peer parses it against the mesh's public
key, asserts facts about itself and the request, and runs the token's checks plus its own policy
under a bounded authorizer. A refusal says which condition failed and whether retrying could
help: `401` means a refresh might work, `403` means it will not.

## What will surprise you

- **`pnpm start` without `pnpm bootstrap`** stops at once:
  `[httpeers-stack] httpeers.json not found -- run "pnpm bootstrap" first.`
- **`pnpm start` rebuilds the pages every time**, because the static server only serves
  `dist/{app,image-peer,hub}`. A stale or partial build (for example a `dist/hub` without `sw.js`)
  shows up as a page that never reaches "ready" and mint buttons that stay disabled. A failed build
  stops the script: `"pnpm run <target>" failed -- refusing to serve a stale build.`
- **The hub fails loudly without the relay:**
  `hub: could not reserve a circuit slot through the relay at "<addr>" -- no browser can reach this hub without one. ...`
- **An invitation works once.** A second page using the same code fails with `already-redeemed`.
- **Port 9091 is a wildcard bind.** On a server it is reachable from the network, not just
  `localhost`. Firewall it like the relay if it should not be public.
- **HTTPS is required off localhost, all or nothing.** ServiceWorkers need a secure context, so
  the pages do not start over plain HTTP on another host, and an `https://` page cannot dial a
  `ws://` relay. The relay and the static server terminate TLS themselves when `TLS_CERT` and
  `TLS_KEY` point at PEM files; the relay then listens on `wss`. Certificate issuance and renewal
  are not built.
- **`GET /admin/invitations` lists nothing.** It returns only `{ ok, issuedBy, caller }`.
- **`peer.test.ts` D8 in `httpeers.core` is load-sensitive.** It fires 20 concurrent requests
  over one connection. Under heavy CPU contention it has thrown `StreamResetError` from yamux's
  window handling, a transport reset that aborts the run before the identity assertion; no run has
  shown a crossed identity. The browser streaming assertion degrades the same way.

### Known gaps

- **Tokens are not least-privileged.** Audience is expressible and enforced by the destination,
  but the join protocol mints unrestricted tokens, so a member's token is valid at every peer.
- **No body-size bound.** On a runtime without request streams, a peer can make a server buffer a
  whole upload before the handler runs.
- **No hop limit on forwarding.** Forwarding is deny-by-default and no peer here relays, so it is
  inert, but a relaying peer would need one.
- **Fixture data** sits behind a one-function seam in both services, so a real backend swaps in
  without touching a handler.

## Reference

### Commands

| Command | What it does |
| --- | --- |
| `pnpm bootstrap` | Generate or read keys, write `httpeers.json` |
| `pnpm start` | Build the three pages, start relay, hub and static server |
| `pnpm start:relay` / `start:hub` / `start:static` | One process on its own |
| `pnpm dev:app` / `dev:image-peer` / `dev:hub-page` / `dev:proxy` | Vite dev server for one page |
| `pnpm build:app` / `build:image-peer` / `build:hub-page` / `build:proxy` | Build one page into `dist/` |
| `pnpm test` | Typecheck the tests, then vitest (node and browser e2e suites, real relays and hubs on real ports) |
| `pnpm typecheck` | `tsc --noEmit` |

The browser e2e suites need Playwright's Chromium and Firefox:
`pnpm exec playwright install --with-deps chromium firefox`.

### Configuration

| Variable | Used by | Default |
| --- | --- | --- |
| `RELAY_PORT` | relay listen port; `start.sh` waits on it | 9090 |
| `HUB_PORT` | hub TCP listener | 9091 |
| `HUB_READY_FILE` | hub, `start.sh` | `.httpeers/hub-ready` |
| `HTTPEERS_CONFIG` | hub | `httpeers.json` |
| `RELAY_ADDR` | hub; overrides `relayAddrs[0]` from `httpeers.json` | |
| `TLS_CERT`, `TLS_KEY` | relay, static server | plain HTTP / `ws` |
| `PUBLIC_HOST` | static server; host name it prints under TLS | `127.0.0.1` |
| `APP_DIST_DIR`, `IMAGE_PEER_DIST_DIR`, `HUB_PAGE_DIST_DIR` | static server; where the built pages are | `dist/{app,image-peer,hub}` |

### Technology

| Layer | Choice |
| --- | --- |
| Transport | `libp2p` 3: WebSockets to the relay, circuit-relay v2 for reservations, WebRTC browser-to-browser, TCP for host peers. No gossipsub. |
| HTTP over streams | `@statewalker/webrun-http-streams`: a `Request`/`Response` pair over any duplex byte stream, streaming both ways. |
| Browser edge | `@statewalker/webrun-http-browser`: a ServiceWorker adapter that makes a page's own `fetch()` reach a handler running in that page. |
| Tokens and policy | Biscuit tokens and Datalog rules through `@statewalker/webrun-biscuit` (pure TypeScript), via `@statewalker/httpeers.core`. |
| Build and test | Vite, Vitest, Playwright (Chromium and Firefox). |
