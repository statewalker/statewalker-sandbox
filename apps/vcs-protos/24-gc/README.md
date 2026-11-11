# 24 — Can a repository garbage-collect and repack safely — concurrent writers, resumable, on every backend?

Plan id **X18** (safe GC). Status: **open**.

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
