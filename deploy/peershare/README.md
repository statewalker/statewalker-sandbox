# Deploying PeerShare

## What it is

PeerShare's own pieces on one host, behind Caddy:

| Host | What |
|---|---|
| `PAGE_HOST` (e.g. `tools.sandclaw.ai`) | the page (`apps/peershare.page`): `/peer-share` and `/peer-share/invite`, plus `/peershare.json` |
| `*.SESSION_ZONE` (e.g. `*.p.sandclaw.ai`) | the session shell: one isolated origin per Guest's Service (ADR 0003) |

The **relay** is httpeers' own (`relay.httpeers.net`), already deployed with the limits
PeerShare needs (1 GiB and 6 h per relayed connection; rung 11). `--profile relay` runs one
here instead, from httpeers' relay image.

## Choosing the zones (decision 2.8, open)

The session shell admits only parent pages in `PARENT_ZONE`: the zone itself or one label
under it. That leaves two options:

1. **Page under `httpeers.net`** (e.g. `peershare.httpeers.net`): publish `srv/page` as a
   site on httpeers' existing static host, and use the deployed `*.p.httpeers.net` zone. No
   new infrastructure.
2. **Page on `tools.sandclaw.ai`** with its own zone `*.p.sandclaw.ai`: this stack, with
   `PARENT_ZONE=sandclaw.ai`, `SESSION_ZONE=p.sandclaw.ai`. It needs DNS records for
   `tools` and `*.p`, and a wildcard certificate (DNS-01, so an ingress image with your
   DNS provider's module; httpeers' `deploy/ingress` is the Gandi one).

## How to run it

```sh
cp deploy/peershare/.env.example deploy/peershare/.env   # and fill it in
set -a; . deploy/peershare/.env; set +a
node deploy/peershare/build.mjs                          # srv/page, srv/shell, srv/config
docker compose -f deploy/peershare/docker-compose.yml up -d
```

## Internals

- `build.mjs` builds the page and the shell, and writes `peershare.json` from the
  environment. The shell is built with `__PEERSHARE_SESSION_ZONE__` and
  `__PEERSHARE_PARENT_ZONE__` (vendored shell, edit 4 in
  `apps/peershare.page/PROVENANCE.md`).
- `apps/peershare.page/tests/deploy.test.ts` brings this stack up with Compose under real
  host names (`peershare.localhost`, `*.p.localhost`, one wildcard certificate trusted by
  its SPKI hash) and runs the whole scenario through it in Chromium. The relay runs on the
  test host there, because the relay image's registry is not reachable from every machine.
- **Relay review (rung 05, finding 4):** libp2p's default inbound rate limit per address
  dropped Guests' dials when several joined from one address within a second. An office
  behind one NAT is that case. httpeers' relay should raise
  `connectionManager.inboundConnectionThreshold` and `maxIncomingPendingConnections`;
  this is a change in httpeers (`apps/relay`), proposed and not made here.
