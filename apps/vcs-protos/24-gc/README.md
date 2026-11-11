# 24 — Can a repository garbage-collect and repack safely — concurrent writers, resumable, on every backend?

Plan id **X18** (safe GC). Status: **answered — yes: native `gc --prune=now`'s object set at 0.84× its pack size; grace by a ledger (no mtimes); re-mark and leases keep concurrent writers safe; resumable phases; files and SQL.**

## Question

Every push, fetch and commit adds packs and loose objects; refused pushes (X8b) and rewritten
history leave unreachable ones. git's `gc` repacks what is reachable into one pack and `prune`s
what has been unreachable longer than a grace period (`gc.pruneExpire`, 2 weeks), with roots in
every ref, HEAD and the reflogs. Can the same run on X16a's stores — git files and SQL — inside a
Durable Object that may be evicted between steps, while other writers keep adding objects and
moving refs, without ever deleting an object that is or becomes reachable?

## Reject condition

Rejected if gc can delete an object reachable at the end of the run (a ref moved during gc, a
writer reusing an old object), if a crash between steps loses objects or leaves the store
unreadable, if unreachable objects are deleted before their grace period, or if the result is not
what native `git gc --prune` keeps.

## Design (decided before code)

- **Roots**: every ref (`refs/*`, any namespace), HEAD (also detached), every reflog entry's old
  and new ids.
- **Mark** = X6c's walk from the roots (it also lists the objects to repack, with their paths).
- **Repack** = X6e's search over the marked objects, streamed into X6b's install: one new pack.
- **Grace without mtimes** (SQL rows have none): a ledger on the store's FilesApi records when gc
  first saw each object unreachable; an object is deleted only when it has stayed unreachable for
  the grace period (`graceMs`, default 14 days) — and is dropped from the ledger when it is
  reachable again.
- **Only the snapshot**: gc deletes only objects and packs present when it started; anything
  written during the run is untouched.
- **Re-mark before the sweep**: roots are walked again just before deleting; an object reachable
  then (a ref moved during gc) is kept even if it was unreachable at the start.
- **Leases** close the last window (a writer reusing an old object between the re-mark and its
  ref update): the sweep sets a flag, then checks for live leases (any → deferred, nothing
  deleted); a writer takes a lease, then checks the flag (set → it waits for the sweep to end).
  Each side checks after it writes, so at least one sees the other.
- **Resumable**: phases (snapshot, mark, repack, ledger, sweep) with their state in files; each
  step may run in a fresh handle (a Durable Object restarted).

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | A bare repository with history, rewritten branches and dangling objects (reflogs expired): after `gc` with the grace past, its object set equals native `git gc --prune=now`'s on a copy; one pack, no loose objects; refs unchanged; `fsck --strict` clean; pack ≤ 1.15× git's. |
| R2 | Grace: a first run keeps the unreachable objects (recorded); a second run past the grace deletes them — except one made reachable in between. |
| R3 | Roots: objects reachable only from `refs/peers/*`, a detached HEAD, a reflog entry or an annotated tag are all kept. |
| R4 | Concurrent writers: between every phase a writer adds commits and moves refs — one ref resurrects an old unreachable commit after the mark; at the end every reachable object is present (`fsck --strict`). |
| R5 | Leases: a live lease defers the sweep (nothing deleted); after its release the run completes; a writer taking a lease during a sweep waits for it to end. |
| R6 | Resumable: one phase per step, each with a fresh repository handle, gives the one-shot result; a crash injected after each phase is resumed to the same result. |
| R7 | SQL backend: loose rows and several packs → one pack; unreachable rows removed after the grace; the log reads the same. |

## Scope — what this slice does NOT do

- Cruft packs (git keeps unreachable-but-young objects in a cruft pack with per-object mtimes):
  here such objects stay where they are (their pack is kept until all its unreachable objects
  expire). Bitmaps, commit-graph, multi-pack-index (R7 perf backlog). Index (worktree) roots:
  the stores are bare (X14).

## Answer

**Yes.** `gc(repo, { graceMs })` runs `gcStep` until done (or deferred by a lease); `gcStep(repo,
{ units })` runs that many phases, each persisted under the store's `gc/` directory (on the pack
FilesApi: `.git/gc/` for git files, SqliteFilesApi tables for SQL), so a fresh handle — a restarted
Durable Object — resumes it. `withLease(repo, fn)` is what a writer that may reuse old objects
holds (X8b's receive-pack between its connectivity check and its ref update is the case).

| | |
|---|---|
| a messy bare repository (rewound branch, dropped branch, dangling loose objects) | object set = native `git gc --prune=now`'s; one pack; no loose objects; refs unchanged; `fsck --strict` clean; 13 259 B vs git's 15 718 B (0.84×) |
| grace | first run: unreachable objects recorded and kept (loose and packed: a pack with a young unreachable object stays); past the grace: deleted, the old pack too; one made reachable meanwhile kept |
| roots | `refs/peers/*`, a detached HEAD, a reflog entry, an annotated tag |
| concurrent writers | pushes after every phase, a ref resurrecting an old unreachable commit after the mark: all kept, `fsck --strict` clean |
| leases | a live lease → `deferred`, nothing deleted; a writer arriving during a sweep runs after it |
| resumable | one phase per step with fresh handles = the one-shot result; a crash after each phase resumed to it |
| SQL | two packs and loose rows → one pack, no loose rows, the dangling row removed, the log the same |

- **Store additions**: X4's `GitObjects.remove`, X6r's `ObjectDatabase.readers()`, and X16a's
  optional `ObjectStore.gc` (`GcAccess`: the gc directory and the repository root, packs with
  their ids, kept packs, loose ids, `removeLoose`, `removePacks` — idx before pack, companions
  too, then the pack database reopened — and `refresh`); the store leaves freshen markers once gc
  is in use, and a read failing on a pack removed by another handle rescans and retries.
- **Cost**: two walks (mark and re-mark) and one repack per run; memory holds the reachable set
  and the ledger (an object id each).

## Verified

All 16 Node tests pass (`pnpm test 24-gc`: R1–R7 and 9 from the review of #87); 09–23's suites pass
with the store changes (178 tests together). The tests were written first (red commit).

### Mutation check

| Mutation | Caught by |
|---|---|
| G1 no re-mark before the sweep | R4 (the resurrected commit) |
| G2 packs written during the run swept too | — not caught; first recorded as equivalent, which the review showed wrong: the ledger is keyed by id, so an old id written again during gc is in it. Freshen markers now protect such ids (H6); the snapshot rule remains a second guard |
| G3 grace ignored | R2 |
| G4 leases not checked | R5 |
| G5 a writer does not wait for a running sweep | R5 |
| G6 reflogs not roots | R3 |
| G7 a pack removed although some of its objects may not go | R2 (a young unreachable packed commit) |
| H1 the flag removed without its owner's token | — equivalent: a second sweep returns `deferred` before it can reach the removal; the token check is a second guard (a flag taken over after expiry) |
| H2 another live sweep does not defer | #87: second sweep |
| H3 the flag not renewed | #87: renewal |
| H4 a lease not renewed | #87: renewal |
| H5 no recent-object closure | #87: recent objects |
| H6 freshen markers ignored | #87: written again |
| H7 the ledger keeps deleted ids | — equivalent for safety: a re-added object leaves a freshen marker that restarts it; the cleanup bounds the ledger's size |
| H8 no worktree roots | #87: worktrees |
| H9 `.keep` packs deleted | #87: `.keep` |
| H10 shallow commits not passed to the walk | #87: shallow |
| H11 stale handles do not retry | #87: stale handle |
| H12 index objects not roots | #87: worktrees (the staged blob) |

### Review of #87

| Finding | Resolution |
|---|---|
| Any second sweep removed the shared flag: a waiting writer ran mid-deletion and lost its object | The flag is owned (a token): another live sweep's flag defers a sweep; only its owner removes it |
| The flag and leases expired after 10 minutes, unrenewed | Renewed every third of their TTL while held |
| Objects reachable from unexpired unreachable objects were deleted (git keeps them: `add_unseen_recent_objects_to_traversal`) | Their closure is protected (a walk tolerant of missing objects) |
| An object written again kept its old grace (git freshens) | The store leaves freshen markers under `gc/fresh` (a loose id, or a pack) once gc is in use; the ledger restarts them; the sweep honours markers written since |
| Ledger entries of deleted objects remained: a re-added object went at once | The sweep drops them |
| Linked worktrees' HEADs, reflogs and indexes were not roots | Roots, with the blobs and cache-tree trees of every index (v2/v3; v4 refused, not guessed) |
| `.keep` packs deleted; `.rev`/`.bitmap` left orphaned | Kept packs are never removed; a pack goes with its companions |
| A handle opened before another handle's gc could not read the removed packs' objects | Reads rescan and retry when the pack set changed (a corrupt copy in an unchanged set stays refused — the first version of this fix forgot X6r's bad-copy marks and failed X6d's test); gc refreshes its view each step |
| Shallow repositories could never be collected | The shallow file bounds the walk |
| R6's crash after "sweep" tested nothing; no crash inside a phase | A crash after the second deletion of a sweep is resumed to the one-shot result |
| Writers do not take leases; very large repositories; concurrent gc runs sharing state | Open threads |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/gc.ts` | **Adopt** | git's gc/prune semantics, portable grace, safe with writers, resumable |
| store additions (`GcAccess`, `remove`, `readers`) | **Adopt** | the minimum gc needs from every backend |

## Open threads (ranked by how much later work they would invalidate)

1. **Leases in the writers**: X8b's receive-pack and X16a's `commit` should hold `withLease` (only
   the tests do now).
2. **Cruft packs** (git's: unreachable-but-young objects in one pack with per-object times), so a
   pack holding one young object is not kept whole.
3. **A bounded repack** for very large repositories inside a Durable Object (the repack is one
   step now): X6b2's resumable install fed by a resumable writer.
4. Bitmaps, commit-graph, multi-pack-index (R7 perf backlog); concurrent gc runs (one state per
   store: a second run resumes the first).
