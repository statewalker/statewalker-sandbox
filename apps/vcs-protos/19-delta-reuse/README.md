# 19 — Can export reuse what packs already hold — compressed entries and deltas — as git does?

Plan id **X6** (pack ingest/export), slice **X6d: delta reuse in export**. Status: **open**.

## Question

X6c exports whole objects: every object is inflated from wherever it is stored and deflated
again, and the pack is 3.8× git's. git's `pack-objects` reuses: an object stored whole in a pack
is copied as its compressed bytes; an object stored as a delta whose base is also sent is copied
as that delta; with `--thin`, a delta whose base the receiver has is sent against that base
(`REF_DELTA`, completed by the receiver's `--fix-thin`). Can our export do the same over X16a's
backends — reading raw entries from X6r's packs, checking them (git checks the idx CRC before
reusing), never sending a delta cycle — and what does it gain?

## Reject condition

Rejected if a reused entry can carry corruption into the export unnoticed, if an export can
contain a delta cycle (two packs storing A against B and B against A), if git or X6b refuse the
result, or if reuse does not bring the size near git's.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | A history packed by native git, exported with reuse: git's object set, accepted by `git index-pack` and `fsck --strict`, the pack within 1.25× of `git pack-objects` for the same objects, and more than 90 % of the objects copied as stored (no inflate/deflate). |
| R2 | Thin: `HEAD ^HEAD~5` with `thin` is smaller than without, uses deltas against objects the receiver has, and installs in a native receiver holding `HEAD~5` (`index-pack --fix-thin`) and in X6b (files backend); both pass `fsck`. |
| R3 | A packed entry whose bytes no longer match the idx CRC is not passed on: the export fails with a PackError. |
| R4 | Two packs storing A as a delta against B and B as a delta against A: the export contains no cycle; git accepts it. |
| R5 | SQL backend: packs kept in SqliteFilesApi are reused as on git files; loose objects (X3b rows) are sent whole. |
| R6 | A 64 MiB blob stored whole in a pack is copied with < 16 MiB extra live and no deflate. |

## Scope — what this slice does NOT do

- Delta search (computing new deltas between objects stored whole or loose): the next slice if
  R1 shows a gap; OFS_DELTA output (`REF_DELTA` is used for every reused delta).
