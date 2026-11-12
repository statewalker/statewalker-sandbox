# 38 — Can folders sync through git history and converge?

Plan id **X17** (workspace sync on history). Status: **answered — yes: three endpoints converge on one commit and the same files after 200 random schedules, non-overlapping edits merge cleanly, conflicts are committed and reported, and two endpoints merging each other apart make the identical commit**.

## Question

webrun-sync keeps folders in step between endpoints (tabs, devices, a Durable Object). If each
endpoint records its folder as git commits and syncs by exchanging commits and merging them, edits
made in parallel merge like branches, nothing is lost, and every endpoint has the whole history.
Does that converge — every endpoint ending on the same commit and the same files — whatever the
order of edits and syncs, with conflicting edits included?

## Reject condition

Rejected if, after a final round of syncs with no new edits, two endpoints hold different commits
or files; if a non-overlapping edit is lost or reported as a conflict; or if an endpoint's history
is not a valid git repository.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| S1 | **Non-overlapping edits.** Three endpoints edit different files (adds, edits, deletes, renames, new directories) and sync pairwise in random orders: every merge is clean, and all three end with the union of the edits, on one commit. |
| S2 | **Conflicting edits.** Endpoints edit the same lines, or edit and delete one file: the merge commits the conflicted files (git's markers), reports their paths, and the endpoints still converge on one commit — whichever endpoint merged first. |
| S3 | **Property test.** 200 random schedules over three endpoints (edits, deletes, syncs interleaved): after a final round of syncs every endpoint holds the same commit and files, and every edit no other endpoint touched is in the result. |
| S4 | **Deterministic merges.** Two endpoints merging each other's heads at the same time make the identical merge commit (sorted parents, a fixed identity, the later parent's date), so syncing back is a fast-forward, not another merge. |
| S5 | **Git history.** An endpoint's repository, copied to disk, passes `git fsck --strict`, and `git log` shows each endpoint's edits. |
| S7 | Added after review: a checkout failing halfway loses none of the peer's edits; a transfer failing at any object leaves later syncs working; an edit typed during a sync (after the folder was committed) is kept and merged; no empty directory is left in a folder the syncs changed; renames, and endpoints that started apart, converge. |
| S6 | **Portable.** `src/` has no `node:` imports; the endpoints run on in-memory FilesApis. |

## Scope

- Endpoints sync in one process here; the transport (X7/X8) carries the same objects and refs.
- Folders are plain files (no executable bits or symlinks, as X14 on a FilesApi).
- A FilesApi has no compare-and-swap: between the checkout's check of a path and its write there is
  still an instant in which a user's write would be overwritten.
- A conflicting binary file holds one side's bytes (the parent with the smaller id, as git's
  merge keeps "ours"); the other side's version is in the history, and the conflict is reported.

## Answer

Yes. `src/workspace.ts` (about 230 lines, no `node:` imports) builds it from X16a's repository, X5's
refs on a FilesApi (X15's `filesRefFiles`) and X13f's recursive merge. All 13 tests pass:

- **S1.** 30 random schedules of non-overlapping edits (adds, edits, deletes, new directories)
  and syncs over three endpoints: no conflict, one commit and the same files everywhere.
- **S2.** The same lines edited on two endpoints, and an edit against a delete: both paths
  reported, the conflicted files committed with git's markers, and the three endpoints converge,
  whichever merged first.
- **S3.** 200 random schedules (15 steps of edits, deletes and syncs each): after a final round,
  one commit and the same files everywhere, and every path only one endpoint touched holds that
  endpoint's last edit (or is gone, if it was deleted).
- **S4.** Two endpoints merging each other's heads apart (copies taken before either merged), with
  disjoint and with conflicting edits: the identical merge commit, even when one merges later.
- **S5.** An endpoint's repository on disk passes `git fsck --strict`; `git log` names a, b and c.
- **S7.** Failures halfway through a checkout or a transfer, edits during a sync, directories,
  renames and unrelated starts.

**How a sync works.** Both folders are committed when they differ from their head (author: the
endpoint). `a` copies the objects of `b`'s head it lacks (a commit present has its history), and
merges: nothing when `b`'s head is an ancestor, a fast-forward when `a`'s is, else a merge. Then
`b` copies `a`'s result and fast-forwards. Objects travel children first, so a stored commit
always has its tree, blobs and parents. The folder is moved from the old tree to the new one, path
by path, only where it still holds the old version: a path the user changed meanwhile keeps the
user's bytes and is committed by the next sync. Each endpoint records the commit its folder was
last checked out at (git's index, reduced to a tree); a checkout cut short is finished at the next
sync before the folder is committed, so a half-written folder is never taken for local edits.

**Why it converges on one commit.** A merge commit depends only on the two heads: parents in id
order (the smaller one is "ours" for the merge too), the identity `sync`, the later parent's
committer date, labels from the parent ids, and a message listing the conflicts. Two endpoints
merging the same heads, at any time, make the same commit, so a sync back is a fast-forward and a
round of syncs with no new edits leaves every endpoint on one commit. The first S4 test did not
show this (the second sync was already a fast-forward); the mutation check caught it, and S4 now
merges from copies taken before either side merged.

### Mutation check

| # | Mutant | Result |
|---|---|---|
| V1 | Parents in merge order, not id order | survived the first S4; killed by the rewritten S4 |
| V2 | Merge dated "now" | survived the first S4; killed by the rewritten S4 |
| V3 | Conflicts not reported | killed (S2) |
| V4 | Removed files kept in the folder | killed (S3) |
| V5 | The peer's folder not committed before the merge | killed (S1, S2) |
| V6 | One-way syncs pushing back | survived the first S4; killed by the rewritten S4 |
| V7 | Conflict labels from the merging side | survived the first S4; killed by the rewritten S4 (conflicting edits) |
| V8 | Fast-forwards made into merges | killed (S1, S2) |

## Corrections (from X17b, 39)

| Earlier belief | What the network showed |
|---|---|
| "The folder is recorded as checked out after every checkout" | Not after `commitFolder`'s own commit: locally the next sync repaired it, but a push moving `main` first made the refresh take the endpoint's own committed edit for a user edit and undo the peer's half of the merge. A commit is recorded as checked out now (S8). |
| S7: "an edit typed during a sync is kept and merged" | Kept, but on the real path (typed while the peer's objects arrive) committed on top of the peer's commit, so the peer's change to that path vanished. S7 passed because its hook fired on the old record's write. A checkout now reports user edits kept over changed paths; they are committed on the commit the user worked from and merged in, conflict-marked where they collide. |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/workspace.ts` | **Adopt** (transport, conflict UI, large files to come) | converges on one commit; each step is plain git |

## Open threads

1. Syncs over the network: the object transfer through smart HTTP or webrun-wire (X8, X7), and
   pushes racing on one endpoint (the ref compare-and-swap already refuses a stale update).
2. Conflict resolution in the folder: today the markers are committed; a resolution is an ordinary
   edit and syncs like one.
3. Large files through LFS or Xet pointers (X10, X11) instead of blobs.
4. Rename detection is the merge's (X13); a folder watcher (files-sync events) instead of
   listing the whole folder at each sync.

### Review

| Finding | Fix |
|---|---|
| A checkout cut short left a mixed folder, committed as local edits: the peer's edits reverted everywhere | the checked-out commit is recorded and an unfinished checkout finished first (S7) |
| A transfer cut short stored a commit without its tree: every later sync failed | objects stored children first (S7, every failure point 2–8) |
| Edits made during a sync were overwritten | a path is written only where the folder holds the old version (S7); the check-then-write instant remains (Scope) |
| Empty directories left behind | parents emptied by a removal are removed (S7) |
| Binary conflicts kept one side silently | stated in Scope; reported as conflicts |
| Conflicts of the second merge dropped | both merges' conflicts reported |
| Renames, file/directory swaps, unrelated starts untested | covered (S7) |
| Every sync reads and hashes every file | an open thread (a folder watcher) |
