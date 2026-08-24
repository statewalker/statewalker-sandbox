# httpeers-relay

A publicly dialable peer that forwards connections for peers with no inbound
socket. A stock libp2p Circuit Relay v2 server over WebSockets, configured
entirely by environment, and nothing else.

**A relay holds no directory and makes no membership decision.** It forwards
bytes. Relaying someone's connection grants them nothing: a relayed peer still
has to redeem an invitation, present a token bound to the key it proves, and
satisfy the destination's own policy. Nothing in this package makes a mesh
secure, and nothing here should ever be described as if it did.

It does partition. Every peer announces a **subnetwork name**, and peers with
different names cannot reach each other through this relay — see
[Subnetworks](#subnetworks). That is reachability, not authorisation.

## Why this is its own app

A relay is the one component of this system somebody wants to run on its own.
Everything else — the hub, the pages, the services — is an application; the
relay is infrastructure, and it contains no project logic at all. Splitting it
out means a self-hoster pulls a relay rather than a demo.

The relay we run at a public name is **this same artifact**, deployed. There is
no host-specific code path here and no configuration file: everything is an
environment variable with a documented default, so what we run is reproducible
by anyone. `apps/httpeers-stack` — the reference deployment — depends on this
package rather than keeping a copy.

## Running it

```bash
RELAY_KEY=$(...) pnpm start
```

It prints a block naming its peerId, where its key came from, its TLS mode, and
what it listens on versus what it announces. That block is the thing to paste
into an issue, and the peerId is the line to check after a deploy.

```
relay: ------------------------------------------------------------
relay: peerId     12D3KooW...
relay: key from   RELAY_KEY
relay: tls mode   edge
relay:            a reverse proxy in front of this relay terminates TLS. This
relay:            relay's own port is UNENCRYPTED plain ws and must not be
relay:            exposed directly.
relay: listen     /ip4/0.0.0.0/tcp/9090/ws
relay: announce   /dns4/relay.example.net/tcp/443/wss
relay: mode       open
relay:            any subnetwork name is accepted; peers announcing different
relay:            names cannot reach each other through this relay.
relay:            a peer that announces no name is refused -- there is no default.
relay: limits     maxReservations   15
relay:            reservationTtl    7200000 ms
relay:            perCircuitData    131072 bytes
relay:            perCircuitTime    120000 ms
relay: http       :9099 -- /health, /.well-known/httpeers-relay.json
relay: addresses
relay:   /dns4/relay.example.net/tcp/443/wss/p2p/12D3KooW...
relay: ------------------------------------------------------------
```

## Configuration

Every variable, its default, and whether it is required.

| Variable | Default | Required | What it does |
|---|---|---|---|
| `RELAY_KEY` | — | one of `RELAY_KEY` / `RELAY_KEY_PATH` **is** | The relay's signing key, base64 of an Ed25519 private key in libp2p's protobuf encoding. **Takes precedence over `RELAY_KEY_PATH`.** Use this on a container host. |
| `RELAY_KEY_PATH` | `./.httpeers/relay.key` | see above | The same protobuf, as raw bytes on disk. The local-development default. |
| `RELAY_PORT` | `9090` | no | The port the relay binds. `0` binds an arbitrary free port. |
| `RELAY_ANNOUNCE` | *(announce what it listens on)* | no | Comma-separated multiaddrs peers are told to dial, when that differs from what the relay binds. Every entry must parse as a multiaddr or the relay refuses to start. |
| `RELAY_TLS` | `edge`, or `self` when `TLS_CERT` and `TLS_KEY` are both set | no | Who terminates TLS. See below. |
| `RELAY_MODE` | `open` | no | `open` accepts any subnetwork name; `registered` accepts only the names in `RELAY_NETWORKS`. Neither has a default subnetwork. |
| `RELAY_NETWORKS` | — | with `RELAY_MODE=registered` | Comma-separated subnetwork names this relay will carry. Ignored (and warned about) in `open` mode; an empty list with `RELAY_MODE=registered` refuses the startup. |
| `RELAY_MAX_RESERVATIONS` | `15` | no | How many peers may hold a reservation at once. |
| `RELAY_RESERVATION_TTL_MS` | `7200000` (2 h) | no | How long a granted reservation lives before the peer must renew. |
| `RELAY_DATA_LIMIT_BYTES` | `131072` (128 KiB) | no | Bytes one relayed circuit may carry before the relay closes it. |
| `RELAY_DURATION_LIMIT_MS` | `120000` (2 min) | no | How long one relayed circuit may stay open. |
| `RELAY_HTTP_PORT` | `9099` | no | The second port serving `/health` and the discovery document. `0` binds an arbitrary free port. |
| `TLS_CERT` | — | with `RELAY_TLS=self` | Path to a PEM **file** holding the certificate. |
| `TLS_KEY` | — | with `RELAY_TLS=self` | Path to a PEM **file** holding the private key. |

Nothing else is read from the environment.

### The identity, and why it is a secret

**The relay's peerId is embedded in every multiaddr peers dial.** It appears in
every `httpeers.json`, every invitation and every QR code ever handed out for
this relay. A relay that comes back with a different identity starts perfectly,
logs nothing unusual, holds reservations — and no peer in the world can reach
it, with a symptom ("peers cannot connect") that points nowhere near the relay.

A container host's filesystem does not survive a deploy, so a key file does
not either. That is why `RELAY_KEY` exists and why it wins over
`RELAY_KEY_PATH`: a stale key file baked into an image or mounted from a
template must not be able to override the deployment's actual identity.

Generate one:

```bash
pnpm keygen
# A new relay identity. Keep RELAY_KEY secret and back it up OFFLINE:
# ...
# peerId: 12D3KooW...
RELAY_KEY=CAESQ...
```

It prints; it never writes, so running it twice cannot overwrite an identity.

**Back the key up offline, and write the peerId down.** If the key lives only
in one host's environment, losing that host loses the identity, and with it
every address ever published for this relay. Recording the expected peerId is
what lets you tell a working deploy from a broken one.

To move an existing deployment from a file to a secret, the two formats are the
same bytes:

```bash
RELAY_KEY=$(base64 -w0 .httpeers/relay.key)
```

With neither set, the relay **refuses to start** rather than generating an
identity nobody asked for, and says so naming both options.

### Listen and announce

By default the relay announces the addresses it binds, which is right on a
laptop and on a dedicated box. Behind a reverse proxy it is wrong: the relay
binds `ws` on some internal port while peers must dial `wss` at a public name.
`RELAY_ANNOUNCE` separates the two.

```bash
RELAY_TLS=edge \
RELAY_PORT=9090 \
RELAY_ANNOUNCE=/dns4/relay.example.net/tcp/443/wss \
pnpm start
```

Announce addresses **replace** the listen addresses in what peers are told;
they do not add to them. An entry that does not parse as a multiaddr refuses
the startup, because a relay announcing garbage is unreachable in a way nothing
else will diagnose.

### TLS: `self` or `edge`

| Mode | The relay listens | TLS is terminated by | For |
|---|---|---|---|
| `self` | `wss` | this process, from `TLS_CERT`/`TLS_KEY` | a dedicated box with no proxy in front |
| `edge` | `ws` | a reverse proxy or platform edge in front | a container deployment — **and this is what ours uses** |

`edge` also describes a laptop with no TLS anywhere, which is why it is the
default when no certificate is configured: that is exactly the behaviour this
relay has always had.

**In `edge` mode this relay's own port is unencrypted. Do not expose it
directly.** The startup log says so every time.

Two things are refused or warned about, because both otherwise look like
success:

- `RELAY_TLS=self` with no `TLS_CERT`/`TLS_KEY` **refuses to start**, rather
  than quietly listening plain when you asked it to terminate TLS.
- `RELAY_TLS=edge` (set explicitly) with a `RELAY_ANNOUNCE` that is not
  `wss`/`tls` **warns loudly**. That misconfiguration presents as browsers on
  an `https` origin silently failing to connect — the mixed-content rule
  refuses the dial before anything reaches this relay, so its own logs stay
  clean. Setting `RELAY_TLS=edge` with no `RELAY_ANNOUNCE` at all gets a
  quieter note for the same reason.

  Both are silent when `RELAY_TLS` was *defaulted* rather than chosen. A
  laptop announcing a plain `ws` address is correct, and a warning that fires
  on every local run is one people learn to scroll past.

## Subnetworks

A **subnetwork** is a named reachability domain. Peers sharing a subnetwork
name can dial each other through this relay; peers with different names
cannot. A subnetwork contains one or more meshes and decides nothing about
membership.

**Partitioning is not authorisation.** A name stops strangers stumbling in and
stops cross-subnetwork dialling. It does not make a mesh private — that is
Noise proving identity and the hub deciding what a member may do. The name is
deliberately not called a key, a secret or a credential, because it is none of
those: it travels in `httpeers.json`, in invitations and in QR codes, and this
relay's operator sees every name regardless. **It is unlisted, not
unlistenable** — an unguessable name keeps strangers from stumbling in, and it
does not survive being shared, screenshotted or logged.

Names should therefore be **randomly generated**, and the reason is collision
rather than attack: `dev`, `test`, `home` and `demo` are what people type, and
two unrelated groups on a shared relay would find each other by accident.
`apps/httpeers-stack`'s `pnpm bootstrap` generates one by default.

### How a peer announces one

A peer opens `/httpeers/relay-net/1.0.0` after connecting and **before
reserving**, sends its subnetwork name, and is told whether the relay accepted
it. The relay records `peerId → name` and drops the record when that
connection closes.

```ts
import { announceSubnetwork } from "@statewalker/httpeers-relay/subnetwork";

await node.dial(relayAddr);
await announceSubnetwork(node, relayPeerId, "a3f1c0d29b8e4711aa02");
```

Enforcement is the node's **connection gater**, which is the only admission
hook circuit relay v2 offers — `circuitRelayServer()`'s own options are limits:

- `denyInboundRelayReservation(source)` — a peer with no record cannot reserve.
- `denyOutboundRelayedConnection(source, destination)` — two peers whose names
  differ cannot be connected to one another. This is the half that makes a
  subnetwork real rather than a door policy.

**The gater returns a boolean, so the protocol is what explains.** A peer
refused by the gater sees only a reservation that did not happen, and with a
name now required, *forgot to configure one* is the commonest failure and the
least legible. So the protocol validates and answers in words — "no subnetwork
name announced", "not a subnetwork registered on this relay" — leaving the
gater as the enforcement point and the exchange as the explanation point.

The gater also **waits briefly** (2 s) for an announcement that has not arrived
yet. In practice the announcement lands first — it rides the connection the
dial just established, while libp2p is still waiting on identify before it
reserves — but libp2p does not promptly retry a reservation the relay refused,
so losing that race once would be a stall rather than a retry.

### A name is required

There is no default subnetwork. A peer that announces none is refused in both
modes, and told so over the protocol. This is a **breaking change for every
existing peer**: a peer that reserved against an older relay announces nothing
and will now be refused.

### Open or registered

| Mode | Behaviour | For |
|---|---|---|
| `open` (default) | Any well-formed name is accepted. The relay partitions by whatever it is told and needs no configuration — a subnetwork is created by picking a name. | A public relay. |
| `registered` | Only the names in `RELAY_NETWORKS`, loaded at start, are accepted. Adding one means a restart. | A private or paid relay whose operator wants to bound who consumes the bandwidth. |

```bash
RELAY_MODE=registered RELAY_NETWORKS=a3f1c0d29b8e4711aa02,team-blue pnpm start
```

A name is 1–64 characters: a letter or digit, then letters, digits, dots,
dashes and underscores. Narrow by choice — the value is compared byte for byte
on both sides of a partition, and is written into config files, logs and QR
codes.

## Limits

**On a relay with a public name these are the only thing standing between you
and paying for strangers' bandwidth.** They are worth reading before you point
DNS at one.

| Variable | Shipped default | What it bounds |
|---|---|---|
| `RELAY_MAX_RESERVATIONS` | **15** | Peers holding a reservation at once. The 16th is refused. |
| `RELAY_RESERVATION_TTL_MS` | **7 200 000** (2 hours) | How long a reservation lives before the peer renews it. |
| `RELAY_DATA_LIMIT_BYTES` | **131 072** (128 KiB) | Bytes one relayed circuit carries before the relay closes it. |
| `RELAY_DURATION_LIMIT_MS` | **120 000** (2 minutes) | How long one relayed circuit stays open. |

**Every default is `circuitRelayServer()`'s own**, read out of the installed
`@libp2p/circuit-relay-v2@4.2.11` (`dist/src/constants.js`) rather than chosen
here, so setting none of these changes nothing. That package does not export
them — its `exports` map offers only `.` — so they are *copied*, and
`tests/limits.test.ts` reads that same file off disk and fails if an upgrade
moves any of the four. If you are reading this after a libp2p bump and the
numbers disagree, that test is the thing that should have told you.

**15 reservations is small for a public relay.** It is the right default —
matching upstream means a self-hoster's relay behaves like every other one —
but a relay at `relay.httpeers.net` serving more than fifteen simultaneous
peers needs `RELAY_MAX_RESERVATIONS` raised deliberately, and sized against the
bandwidth the other three limits then permit.

The startup block prints all four every time, and says when one of them is no
longer the shipped value.

## Health and discovery

Two routes, on a **second port** (`RELAY_HTTP_PORT`, default `9099`):

| Route | Answers |
|---|---|
| `GET /health` | `200 {"status":"ok"}` — the liveness check a container platform calls. |
| `GET /.well-known/httpeers-relay.json` | `200 {"peerId","addrs","mode"}` |

```json
{
  "peerId": "12D3KooW...",
  "addrs": ["/dns4/relay.example.net/tcp/443/wss/p2p/12D3KooW..."],
  "mode": "open"
}
```

Anything else is a `404`; a non-`GET` on either route is a `405` with `Allow:
GET`. Nothing is cacheable — a proxy holding yesterday's copy would reintroduce
the stale address this endpoint exists to remove.

**`addrs` is what libp2p actually advertises**, generated per request from the
running node: the announce addresses when `RELAY_ANNOUNCE` is set, the listen
addresses otherwise. That is the whole point — CI and the acceptance checks
**read** this rather than copying an address that goes stale exactly when the
key changes.

**Why a second port.** Sharing the WebSocket listener's port is not available:
`WebSocketListenerInit` declares `server?: Server`, but the public
`webSockets()` options expose only `http`/`https` *ServerOptions* and the
listener calls `net.createServer` itself. Behind a reverse proxy this costs
nothing publicly — two container ports, one public port, routed by path.

There is no way to switch this surface off. `/health` is what a platform
probes, and a liveness endpoint that can be disabled is a deployment that
cannot be checked.

## As a library

```ts
import { startRelay } from "@statewalker/httpeers-relay";

const relay = await startRelay({ port: 0, keyPath: "./relay.key" });
// relay.node.peerId, relay.node.getMultiaddrs(), await relay.stop()
```

`startRelay` reads nothing from the environment; `resolveRelayConfig(env)` is
what turns an environment into its arguments, and `src/main.ts` is the only
place the two meet. That split is why the failure paths an operator actually
hits — the missing key, the truncated secret, the unparseable announce address
— are covered by tests rather than by hand.

## Tests

```bash
pnpm test        # typecheck + vitest
pnpm typecheck
```

The suite boots real relays on real ports and dials them with real peers,
including one case that proves a peer reaching the relay at an **announced**
address that is not the address it binds.
