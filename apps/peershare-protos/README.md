# peershare-protos

## What it is

The **PeerShare prototype ladder and plan**. PeerShare is a SandClaw app: *"I have a
local HTTP service which I want to securely share to invited peers."* It is built on
[HTTPeers](https://github.com/statewalker/httpeers).

Status: **rungs 01–03 answered** ([01](01-upstream-kinds/README.md),
[02](02-bridge-lockdown/README.md), [03](03-local-network-access/README.md)); the rest are planned. The design was settled in a
grilling session (three rounds); the record is in [docs/decisions.md](docs/decisions.md).

| File | What it holds |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | Architecture, the prototype ladder, the application milestones, and the seams to confirm before the first red test |
| [docs/decisions.md](docs/decisions.md) | Every question asked while grilling the draft, with the answer agreed |
| [GLOSSARY.md](GLOSSARY.md) | The domain words: Sharer, Guest, Service, Upstream, Bridge, Invite, Viewer… |
| [docs/adr/](docs/adr/) | The three decisions that are hard to reverse |

## How to run it

```bash
pnpm install          # at the repo root
pnpm test             # in this folder: every rung
pnpm test 01-upstream-kinds
pnpm typecheck
```

## Layout

Same shape as [`httpeers-shell-protos`](../httpeers-shell-protos) and
[`httpeers-lib-protos`](../httpeers-lib-protos): each rung is a folder
`NN-<topic>/` with `README.md` (the question and, once answered, the answer),
`tests/`, and `src/` only for code the rung owns. Rung READMEs open with the
command that runs them, e.g. `pnpm test 02-bridge-lockdown`.
