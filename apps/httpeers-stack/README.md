# httpeers-stack

The installable reference deployment of the httpeers mesh design: a relay, a hub
peer, and two browser peers (an app page and an image peer) that discover and
call each other's services over the mesh.

## The three processes

- **relay** (`src/relay/main.ts`) — a stock libp2p circuit-relay server. Every
  other peer, including the two browser pages, reaches the mesh through it.
  Listens on **port 9090**.
- **hub** (`src/hub/main.ts`) — the mesh's membership, presence, and
  invitation authority. It has no listening port of its own; it holds a
  circuit-relay reservation through the relay and is reached over
  `/p2p-circuit/webrtc`, the same path a browser page uses. (It also has a
  bookkeeping default, `DEFAULT_HUB_PORT = 9091`, used only in tests that
  dial it directly over loopback TCP.)
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
the page's own paste-in form if the query parameter is absent. Invitations
are created programmatically against the running hub process (via
`InvitationStore.create`, `src/hub/persist.ts`) — there is no HTTP endpoint
to mint one, only `GET /admin/invitations` to list ones already issued.

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
