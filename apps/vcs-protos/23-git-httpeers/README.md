# 23 — Can git run between httpeers peers, authorized per service and per ref by Biscuit tokens?

Plan id **X8** (git over httpeers), slice **X8c: the mesh**. Status: **answered — yes: X8a/X8b's handler and clients cross the bridge unchanged; access from httpeers' mesh roles (Biscuit-verified), decided per service and per ref in the handler; a push longer than the bridge's head timeout works.**

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

## Answer

**Yes.** `meshGitHandler(repo, { issuer })` is `withAccess` (httpeers-access) in front of X8a's
upload-pack and X8b's receive-pack; `meshFetch(call, peer, token)` turns a
`createRemoteOverLink` remote into the `fetch` X8a/X8b's clients take — they run unchanged.

- **Roles → capabilities** (`gitRules`), from httpeers' mesh roles as a standard hub issues them
  (its join flow mints `member`; `admin` and `hidden` are the others; a hub refuses roles its rules
  do not know): admin → `git:read`, `git:write`; member and hidden → `git:read`; with
  `gitRules({ contributors: true })` members also get `git:write-own`. Own-namespace pushes are
  opt-in because every peer that joined the mesh is a member. Roles are mesh-wide; the rules a
  serving peer chooses are its repository's policy. The Datalog policy admits any git
  capability; the decisions per service and per ref are code in the handler: upload-pack needs
  `git:read`, receive-pack `git:write` or `git:write-own` — the latter limited to
  `refs/peers/<the proven peer>/*`, checked on the commands **before the pack is read** (a push
  outside the namespace stores nothing) and per ref (`ng <ref> … not allowed …`); a proven id that
  cannot be one ref-name component (a `/` in it) is refused. The peer is the one the transport
  proved (the bridge binds it on arrival), not anything the request says.
- **A push longer than 30 s**: the bridge bounds a call until its response head. X8b's
  receive-pack now reads the commands, answers its head, and streams report-status once the pack
  is in and the refs are updated (protocol errors, found while reading the commands, still get
  their 400). A push throttled to 3 s through a bridge with a 1.5 s timeout succeeds; with the
  head after processing (mutation N1) it fails.
- **Tokens**: expired and foreign-peer tokens → 401, a tampered one → 403 (httpeers' refusal
  table), an unknown role → 403, no token → 401.
- **Errors after receive-pack's head**: answered as a report (`unpack internal error: …`, every
  ref `ng … internal error`) — native git over plain HTTP saw a dropped connection before.
- **The 30 s case** is tested scaled down (a 1.5 s head timeout, a 3 s upload): the mechanism is
  the same; no 30 s test runs.

| | |
|---|---|
| clone, fetch, push over `pairedLinks` | logs equal; the serving repository passes `fsck --strict` |
| member / member with contributors / admin / hidden | read only (403 on receive-pack) / own namespace only / anywhere / read only |
| two members | each pushes `refs/peers/<self>/main`, fetches the other's, cannot overwrite it |
| fetch over the mesh (48 × 256 KiB) | the first byte after 5 of 154 reads (progress during the search) |

## Verified

All 11 Node tests pass (`pnpm test 23-git-httpeers`: R1–R6 and 5 from the review of #84); X8b's 15 pass with the early head. The tests
were written first (red commit).

### Mutation check

| Mutation | Caught by |
|---|---|
| N1 receive-pack's head after processing | R3 |
| N2 members write anywhere | R2, R6 |
| N3 readers may push | R2 |
| N4 no token sent | R1–R4, R6 |
| V1 no check before the pack | #84: a refused push stores nothing |
| V2 errors after the head not reported | #84: error as a report |
| V3 peer ids not validated | #84: a `/` in the peer id |
| V4 own-namespace pushes for members by default | R2, #84: roles as a hub issues them |
| V5 admin not a writer | (the rule set refuses a policy no rule serves: module load fails) |

### Review of #84

| Finding | Resolution |
|---|---|
| The roles clashed with httpeers' mesh roles: every joined peer (`member`) could write its namespace on every repository, admins could not read, `reader`/`maintainer` cannot be minted by a standard hub | `gitRules`: admin writes, member and hidden read; own-namespace pushes opt-in (`contributors`) |
| A refused push still stored its pack (up to 2 GiB per request from any member) | X8b's `authorize` decides on the commands before the pack; a push refused for every ref is answered without reading it |
| Errors after the head lost their status (native git: a dropped connection) | A report: `unpack internal error: …` |
| A peer id with `/` could write another peer's namespace | Refused (an id must be one ref-name component) |
| The headline overstated "Biscuit roles per service and per ref" | Corrected: Biscuit-verified roles; the per-service and per-ref decisions are the handler's |
| R6 tested one direction | Both directions |
| Hostile git input only over plain HTTP | A malformed fetch and push over the mesh; the peer keeps serving |
| No 30 s case | Stated: tested scaled down |
| Revocation not wired; one repository at any path; `x-httpeers-peer` trusted on a plain-HTTP mount | Open threads (revocation, per-path repositories, mounting only behind a transport that sets the proven peer) |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/mesh-git.ts` | **Adopt** (into a `vcs-httpeers` package) | git on a peer: httpeers' mesh roles, access per service and per ref |

## Open threads (ranked by how much later work they would invalidate)

1. **`git-remote-httpeers`**: a git remote helper so native git clones and pushes over the mesh
   (`git clone httpeers://<peer>/<repo>`).
2. **libp2p**: the same handler over `servePeer` between two Node processes and a browser tab
   (the bridge code path is shared; the transport's own limits — stream counts, relays — are not).
3. **Large files P2P (X12)**: LFS batch per peer mount, only missing chunks, resume.
4. Revocation (`RevocationCache`) and token refresh on 401 in the clients.
5. Several repositories per peer (a path → repository map, a policy on `resource`); mount only
   behind a transport that sets the proven peer (`provenPeer` trusts `x-httpeers-peer`).
