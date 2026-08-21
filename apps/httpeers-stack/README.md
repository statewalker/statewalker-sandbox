# httpeers-stack

The installable reference deployment of the httpeers mesh design: a relay, a hub
peer, and two browser peers (an app page and an image peer) that discover and
call each other's services over the mesh.

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
