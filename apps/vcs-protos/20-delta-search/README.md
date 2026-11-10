# 20 — Can export compute new deltas, as git's pack-objects does, to come near git's size where nothing is reusable?

Plan id **X6** (pack ingest/export), slice **X6e: delta search**. Status: **open**.

## Question

X6d reuses what packs hold and reaches 1.05× git for a full export after a gc. Incremental
exports are 1.28× (1.57× thin), because git's gc stores the newest version of each file whole
and the older ones as deltas against it, so the newest commits — what a push or fetch of recent
work sends — have nothing to reuse. History made locally is loose and has no deltas at all.
git computes new deltas (`pack-objects`' window search, JGit's `DeltaWindow`): candidates sorted
by type, path hash and size, each tried against the previous `window` (10) objects, a delta kept
when it is smaller than git's bound, chains capped at `depth` (50). Can our export do the same,
in pure TS, on every runtime, within bounded memory — and what does it gain?

## Reject condition

Rejected if git refuses a computed delta, if memory is not bounded by the window (a window of
large blobs held whole without limit), or if the search does not bring incremental and loose
exports near git's size.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | The delta encoder: random bases and targets with random edits (inserts, deletes, copies, moves) round-trip through X6a's `applyDelta` and through `git index-pack` (a REF_DELTA pack); a copy is never longer than the base allows, an insert never over 127 bytes. |
| R2 | Incremental after gc: `HEAD ^HEAD~5` with search is within 1.10× of `git pack-objects --revs` for the same range, non-thin and thin (`--thin`). |
| R3 | Loose history (no gc): a full export with search is within 1.25× of `git pack-objects` on the same objects, accepted by `index-pack` and `fsck --strict`. |
| R4 | git's ordering and bounds: candidates sorted by type, path hash (git's `pack_name_hash`), size descending; a delta is kept only below git's `max_size` (half the target minus 20, scaled by depth); no chain deeper than 50, reused chains included. |
| R5 | Bounded memory: with `windowMemory` set, the window holds at most that many content bytes plus one object; objects above `bigFileThreshold` are never delta'd nor buffered (a 64 MiB blob: < 16 MiB extra live). |
| R6 | Cost is bounded by the window: comparisons ≤ window × candidates (counted). |
| R7 | X6b (files and SQL backends) installs the searched packs; logs equal git's. |

## Scope — what this slice does NOT do

- Delta islands, bitmaps, `--delta-base-offset` output (OFS_DELTA): REF_DELTA as in X6d.
- Threads/workers: one pass (a later slice if R6's time matters).
