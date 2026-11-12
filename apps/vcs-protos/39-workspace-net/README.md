# 39 — Can folders sync over a network transport, kept in step by a watcher?

Plan id **X17b** (workspace sync over the network). Status: **answered — yes: endpoints that reach each other only through httpeers' bridge converge on one commit and the same files (50 random hub-and-spoke schedules), lost races retry instead of overwriting, a link failing mid-fetch or mid-push leaves both repositories `fsck`-clean, and a polling watcher keeps folders in step with debounced syncs. Two X17 bugs found on the way, both fixed in 38.**

## Question

X17 (38) keeps folders in step through git history, but its endpoints share a process: a sync
reads the other endpoint's objects directly. Across devices, an endpoint only reaches another
through a transport. Can the same history-based sync run over git's own wire protocol — each
endpoint serving its repository as a `FetchHandler` (X8's smart HTTP: upload-pack and
receive-pack) across httpeers' bridge, the others fetching, merging and pushing back — and can a
folder watcher keep endpoints in step without anyone calling `sync`?

## Reject condition

Rejected if endpoints syncing only over the transport fail to converge on one commit and the same
files; if a push that loses a race overwrites the remote's newer commits; if a transport that
fails halfway leaves an endpoint unable to sync later, or a repository native git refuses; or if
the watcher misses a change or syncs once per write in a burst.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| N1 | **Over the transport.** Two endpoints, each serving `serveEndpoint(ep)` across httpeers' `pairedLinks`, edit different and the same files; `syncWith(a, b)` (fetch, X17's deterministic merge, push) leaves both on one commit and the same files — the remote's folder included, checked out after the push arrives. |
| N2 | **Lost races retry.** The remote commits between our fetch and our push: the push is refused as a non-fast-forward (never forced), and `syncWith` fetches, merges and pushes again; nothing the remote committed is lost. |
| N3 | **Property test.** 50 random schedules over three endpoints syncing only through the transport (a hub and two spokes, edits and syncs interleaved): after a final round every endpoint holds the same commit and files, and every edit no other endpoint touched survives. |
| N4 | **Transport failure.** A link that fails during the fetch or during the push (requests rejected after N bytes) leaves both repositories valid (`git fsck --strict`); the next sync over a working link converges. |
| N5 | **Watcher.** `watchEndpoint(ep, peers)` notices a changed folder (portably: polling the FilesApi, no `node:fs`) and syncs it to every peer: an edit on A appears in B's folder with no `sync` call; a burst of 20 writes in quick succession causes at most 3 syncs (debounced); edits on both sides converge; `stop()` ends it. |
| N6 | **Portable.** `src/` has no `node:` imports; endpoints run on in-memory FilesApis. |
| N8 | (X17c) **The refresh does not need the response read.** A link that drops the push's response unread: the serving endpoint's folder is still checked out at the pushed head. |
| N9 | (X17c) **A refresh reports.** `serveEndpoint(ep, { onRefresh })` names the pushed head, the head after the refresh (a merge of the serving endpoint's own edits when it had any) and the paths it committed with conflict markers; `syncWith` reports conflicts merged while committing the folder too; a throwing listener breaks nothing. |

## Scope — what this slice does NOT do

- A real network link (libp2p, WebSocket): httpeers' `pairedLinks` runs the same bridge code over
  a `MessageChannel` (X8c); webrun-wire's port stack over WebSocket is the next transport.
- Access control (X8c's Biscuit tokens apply unchanged) and discovery of peers.
- Filesystem notification APIs (`fs.watch`, FileSystemObserver): polling is the portable floor.

## Answer

**Yes.** `serveEndpoint(ep)` is X8's `gitHandler` over the endpoint's repository; `syncWith(ep,
peer)` commits the folder, fetches the peer's `main` into `refs/remotes/<peer>/main`, merges it
with X17's deterministic merge (checked out into the folder), and pushes the result, never forced.
A peer is a URL and a `fetch`; the tests reach it only through httpeers' bridge (`pairedLinks`,
the same code path as libp2p, X8c).

1. **Lost races retry, they never overwrite.** The push client refuses a non-fast-forward
   (`rejected (fetch first)` / `(non-fast-forward)`), and receive-pack's compare-and-swap covers
   the window between advertisement and update. `syncWith` then fetches, merges and pushes again
   (N2: the remote's commit made between our fetch and our push survives).
2. **The remote's folder follows a push.** receive-pack moves `main`; its post-receive hook
   (X17c: once the report is written, whether or not anyone reads it, as in git and JGit) queues a
   refresh that checks the serving endpoint's folder out at the new head and reports it to
   `onRefresh` (`{ pushed, head, conflicts }`): the serving endpoint's own folder edits are merged
   with the push, so `head` may be a commit past what the pusher's `syncWith` returned, which the
   pusher gets on its next sync. The response does not wait for the refresh: two endpoints syncing with each other at once would otherwise
   wait on each other's queues. An endpoint's own operations (sync, refresh) run one at a time,
   but **incoming pushes are not queued**: they move `main` at any moment, guarded only by
   compare-and-swap. Everything that checks out therefore starts from the commit the folder
   actually holds (the checked-out record), never from `main`; a push landing during an
   endpoint's own sync is checked out with the merge instead of being taken for user edits and
   reverted (review of #114, N7); and a merge whose compare-and-swap loses to a push starts the
   round again rather than failing.
3. **A failing link leaves nothing half-done.** Objects arrive before refs move on both sides
   (X6a's install, receive-pack's order), so a fetch or push cut after 4 KiB leaves both
   repositories `git fsck --strict`-clean, and the next sync completes (N4).
4. **The watcher** polls the folder (`size` and `lastModified` of every file: a FilesApi offers no
   change events everywhere), syncs with every peer once the folder has been quiet for
   `debounceMs`, syncs once at start, and syncs again after a round when the folder changed during
   it. A burst of 20 writes caused at most 3 rounds (N5). `syncEveryMs` adds rounds with no local
   change, to pick up the peers'. A rewrite of the same size within one clock tick is not seen
   until the next change or the next periodic round.

**Two X17 bugs, found because the network separates commit and checkout** (both fixed in 38, with
regression tests):

- **A commit was not recorded as checked out.** `commitFolder` committed the folder but left the
  checked-out record at the previous commit. Locally the next sync repaired it; over the network a
  push moves `main` first, and the refresh's checkout then took the endpoint's own committed edit
  for a live user edit, kept it over the merge, and committed it again — undoing the peer's half of
  the merge (N1 failed this way; S8 now pins it).
- **A user edit kept over an incoming change was committed on top of it.** When the user edits a
  path while a peer's change to the same path arrives (typed during a sync, or not yet committed
  when a push lands), X17 kept the user's bytes and the next commit recorded them on top of the
  peer's commit: the peer's change vanished without a conflict, though the user never saw it. The
  checkout now reports such paths; their edits are committed on top of the commit the user worked
  from, and that commit is merged in deterministically, so both sides survive, conflict-marked where
  they collide. X17's S7 had passed only because its hook fired on the old record's write, before
  the folder was committed; on the real path it now shows the conflict it expects, and N2b covers
  the push case.

### Verified

All 14 tests pass (`pnpm test 39-workspace-net`), and X17's 14 (`38-workspace-sync`, S8 and S9 new).

| # | Result |
|---|---|
| N1 | Over the bridge: different files and different lines of one file merge cleanly; both endpoints on one commit, the remote's folder checked out; both repositories `git fsck --strict`. |
| N2 | The remote commits between fetch and push: the push is refused, `syncWith` retries (2 attempts), the remote's file survives. N2b: an uncommitted edit on the remote meets a push to the same path: both texts survive in the file, on both endpoints. |
| N3 | 50 random hub-and-spoke schedules (edits, a shared file that conflicts, syncs only through the bridge): every endpoint on one commit and the same files; every edit no one else touched survives. |
| N4 | A link cut after 4 KiB of the fetch's response, or of the push's request: `syncWith` rejects, both repositories pass `fsck --strict`, the next sync converges (60 / 90 files). |
| N5 | An edit on A appears in B's folder with no `sync` call; 20 quick writes cause ≤ 3 rounds; a change made during a round is synced after it; `stop()` during a round lets it finish and nothing runs after; `stop()` during a look at the folder starts no round; `idle()` after `stop()` returns; watchers on both sides converge. |
| N7 | (review of #114) A push lands on an endpoint during its own `syncWith` (while it fetches from another peer): the pushed edit and deletion survive, nothing is reverted. A push moving `main` between the merge's read and its compare-and-swap is retried (2 rounds), not thrown. |
| N6 | `src/` has no `node:` imports. |
| N8 | (X17c) A push whose response the link drops unread: the serving endpoint's folder reaches the pushed files and head anyway. |
| N9 | (X17c) A push over an uncommitted edit on the same path: `onRefresh` gets `{ pushed, head, conflicts: ["p.txt"] }`, `head` the serving endpoint's merge (past `pushed`); a clean push reports `conflicts: []` and `head === pushed`; a throwing `onRefresh` breaks nothing; `syncWith` on an endpoint whose `main` a bare push moved (folder not yet checked out) reports the conflict its folder commit merged. |

### Mutation check

| Mutation | Caught by |
|---|---|
| T1 a lost race is not retried | N2 |
| T2 no refresh after a push | N1 |
| T3 the fetched head is not merged | N1 |
| T4 no debounce | N5 burst |
| T5 the watcher ignores changes | N5 |
| T6 `stop()` does not stop a round in progress | N5 stop — survived first, because the after-round snapshot also swallowed changes made during the round (a bug, fixed); killed once that was fixed |
| T7 no sync at start | N5 |
| X1 (38) a commit not recorded as checked out | X17 S3, S8, N1 |
| X2 (38) kept user edits not merged (sync) | X17 S7 |
| X3 (38) kept user edits not merged (refresh after a push) | N2b — survived first, test added |
| X4 (38) the user's own committed bytes not recognised in the follow-up checkout | X17 S7 (by a timeout: the recursion does not end) |
| R1 (38, review of #114) a checkout starts from `main`, not from the folder's commit | N7 push during a sync |
| R2 (38) kept edits recorded nowhere before the checkout is | X17 S7 |
| R3 (38) recorded kept edits not finished by `commitFolder` | X17 S9 |
| R4 a lost race inside the merge is thrown | N7 |
| R5 `stop()` during a look at the folder not honoured | N5 — survived first (the test's change was not yet due), test sharpened |
| R6 `idle()` after `stop()` waits forever | N5 — survived first, test added |
| C1 (X17c) receive-pack's post-receive hook never called | N8, N9 |
| C2 `syncWith` drops the folder commit's conflicts | N9 |
| C3 `onRefresh` gets no conflicts | N9 |
| C4 a throwing `onRefresh` not caught | N9 (an unhandled rejection) |
| C5 the first `main` command instead of the last | none: equivalent (a push names `main` once) |
| C6 (22) a throwing post-receive hook not caught | X8b R8 (an unhandled rejection) |

## Promotion grades

| File | Grade | For |
|---|---|---|
| `src/net-sync.ts` | **Adapt** | webrun-sync's network sync: `serveEndpoint`, `syncWith`, `watchEndpoint`. |

## Open threads

1. **A real link**: webrun-wire's port stack over a WebSocket (`messageTargetOverWebSocket` +
   `overPipe` + `webrun-http-streams`' `fetchOverDuplex`), once those packages are released.
2. **Change events** where the platform has them (`fs.watch`, FileSystemObserver), with polling as
   the fallback; content hashes for same-size rewrites within a clock tick.
3. **Many peers**: a hub syncing with spokes that are offline, peer discovery, and fairness when
   one peer is slow (rounds are sequential per endpoint today; `peerTimeoutMs` bounds one peer).
4. ~~The refresh after a push needs the response read~~ — answered by X17c: receive-pack's
   post-receive hook queues it (N8).
5. ~~What a refresh reports~~ — answered by X17c: `onRefresh` (N9). The pusher learns of the
   serving endpoint's merge on its next sync, not from the push itself.
