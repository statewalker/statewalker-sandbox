# 23 — Can git run between httpeers peers, authorized per service and per ref by Biscuit tokens?

Plan id **X8** (git over httpeers), slice **X8c: the mesh**. Status: **open**.

## Question

X8a/X8b give git as a `FetchHandler`; httpeers carries `FetchHandler`s between peers (the
bridge over any duplex, libp2p in production) and decides access with Biscuit tokens
(`withAccess`: verified membership, roles → capabilities, Datalog policy on `operation` and
`resource`). Can a peer serve its repository to the mesh — reads for readers, pushes for members
only into their own namespace `refs/peers/<peerId>/*`, everything for maintainers — and can
another peer clone, fetch and push through `createRemoteOverLink` with X8a/X8b's clients
unchanged? The plan's red tests: a push longer than 30 s (the bridge bounds a call until the
response head), the first byte before pack generation ends, Biscuit `authorize`, hostile inputs,
`refs/peers/<id>/*`.

## Reject condition

Rejected if git cannot cross the bridge unchanged, if a long push fails on the bridge's timeout,
if a token's capabilities can be exceeded (a reader pushing, a member writing outside its
namespace, an expired, foreign or tampered token accepted), or if a fetch's first byte waits for
the whole pack.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Over `pairedLinks` (MessageChannel) with a maintainer token: clone, fetch after new commits, push a branch — logs equal, the serving repository passes native `fsck --strict`. |
| R2 | Roles: no token → 401; a reader clones but cannot push (403 on receive-pack); a member pushes to `refs/peers/<its peer>/*` and nowhere else (`ng … not allowed`); a maintainer pushes anywhere. |
| R3 | A push whose upload outlasts the bridge's request timeout (timeout 1.5 s, upload throttled to 3 s) succeeds: the response head comes before the upload ends. |
| R4 | A fetch over the mesh: the first progress byte arrives before half of the objects are read. |
| R5 | Hostile tokens: expired, minted for another peer, tampered → 401; a token whose role the rules do not know grants nothing (403). *Amended: a tampered token is 403 — httpeers' documented refusal table answers 401 only where a fresh token may help (expired, peer binding) and 403 where it cannot (a bad signature); refused either way, the reason in the body.* |
| R6 | Two members push to their own namespaces; each fetches the other's refs; neither can overwrite the other's. |

## Scope — what this slice does NOT do

- libp2p itself (the bridge over `MessageChannel` is the same code path as over libp2p streams);
  native git over the mesh (needs a `git-remote-httpeers` helper); LFS (X12).
