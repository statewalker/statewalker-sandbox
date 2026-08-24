# httpeers-relay

A publicly dialable peer that forwards connections for peers with no inbound
socket. A stock libp2p Circuit Relay v2 server over WebSockets, configured
entirely by environment, and nothing else.

**A relay holds no directory and makes no membership decision.** It forwards
bytes. Relaying someone's connection grants them nothing: a relayed peer still
has to redeem an invitation, present a token bound to the key it proves, and
satisfy the destination's own policy. Nothing in this package makes a mesh
secure, and nothing here should ever be described as if it did.

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

## Limits

Reservation limits are at `circuitRelayServer()`'s own defaults — 128 KB and
2 minutes per circuit among them. On a relay with a public name those defaults
are the only thing standing between you and paying for strangers' bandwidth.
Making them configurable is separate, scheduled work; until then, size the host
for an open relay or keep it off a public name.

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
