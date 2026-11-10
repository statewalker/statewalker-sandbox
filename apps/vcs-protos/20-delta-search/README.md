# 20 — Can export compute new deltas, as git's pack-objects does, to come near git's size where nothing is reusable?

Plan id **X6** (pack ingest/export), slice **X6e: delta search**. Status: **answered — yes: incremental and loose exports come out smaller than git's (0.84–0.99×), with git's order and bounds, a window bounded in memory, and big files left alone.**

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

## Answer

**Yes.** `exportPackSearching(repo, wants, haves, { thin, window, depth, windowMemory, bigFileThreshold })`
(and `writePackSearching` for a list) runs git's delta search over the objects X6d would send whole,
then writes through X6d's writer (a new `computed` plan: a REF_DELTA with the delta's bytes).

| | ours | git `pack-objects` | ratio |
|---|---|---|---|
| 5 loose commits after a gc, `HEAD ^HEAD~5` | 5 856 B | 6 633 B | 0.88× |
| the same, thin | 2 891 B | 3 293 B | 0.88× |
| 5 commits stored whole by a gc (X6d: 1.28×) | 6 172 B | 6 756 B | 0.91× |
| the same, thin (X6d: 1.57×) | 3 384 B | 3 405 B | 0.99× |
| a 30-commit history never packed, full | 34 555 B | 41 268 B | 0.84× |

- **git's search**: candidates sorted by type, `pack_name_hash` of the path, size (descending)
  and the walk's order; each tried against the `window` (10) before it, most recent first,
  stopping at another type; git's `try_delta` bounds (half the target minus 20 bytes, or the best
  so far, scaled by the base's depth — the scaled bound is what the encoder gets; a same-sized
  delta wins only with a shallower base; no base at `depth`; no target under 1/32 of the base).
  The encoder gives up as soon as the bound is passed. Reused deltas keep their base (git too),
  and a candidate's reused-delta descendants lower the depth it may take (git's
  `check_delta_limit`); `depth` bounds the whole pack, reused chains included.
- **Corrupt copies**: candidates are read verified; one that cannot be read is left to X6d's writer
  (sent from another copy, or the export fails before its entry starts).
- **Thin**: the receiver's objects at the paths being sent (read from the edge commits' trees) are
  preferred bases — tried, never sent.
- **The encoder** (git's diff-delta format, X6a's `applyDelta` reads it): a rolling hash over
  16-byte windows, matches verified and extended both ways, copies ≤ 64 KiB, inserts ≤ 127.
  **Finding**: git's index of one entry per 16-byte block, reproduced, gave **4.3× git's delta
  bytes** on git's own (base, target) pairs of a text history — on repetitive text the one
  occurrence that continues past a differing line number is rarely aligned. Indexing every 2nd
  position gives 0.99×, every byte 0.95×. The step grows with the source (every byte up to
  256 KiB, every 2nd up to 1 MiB, every 4th up to 4 MiB, every 16th beyond), the index costing ~9
  bytes per position (≤ 9× a small source, ~0.6× a large one). Of a run of identical windows only
  the first is indexed; ~4 positions per slot, crowded slots thinned evenly (git's HASH_LIMIT 64).
- **Memory**: each window entry keeps its content and index; room is made (oldest first) before an
  entry is indexed, so the window never holds more than `windowMemory` (default 32 MiB, index
  included); an object that alone would exceed it is not kept as a base. Objects above
  `bigFileThreshold` (default 16 MiB) are never loaded — a pair of 64 MiB blobs: +0.6 MiB live.
  Computed deltas are kept by git's delta cache rules (`deltaCacheSize` default 16 MiB, small deltas
  always) and otherwise recomputed when written. With these defaults two similar 15 MiB blobs are
  delta'd at +63 MiB live (sampled after GC; a Durable Object has 128 MiB). git's defaults are
  unlimited window memory, 512 MiB big files and a 256 MiB delta cache.
- **Cost**: comparisons ≤ window × candidates (counted).
- **Parts added**: X6d's writer takes a `refine` step and a `computed` plan (no change for X6d's
  callers); `src/delta-encode.ts`, `src/export-search.ts`.

## Verified

All 23 Node tests pass (`pnpm test 20-delta-search`); X6d's 11 pass with the refactor. The tests
were written first (red commit).

| # | Result |
|---|---|
| R1 | Our encoder on git's own (base, target) pairs: 17 088 B against git's 18 068 B (0.95×); with a forced 16-byte step, 50 one-byte changes cost 359 B (matches extend back over the literals). 300 random edit cases (alphabets of 4 and 256 bytes) round-trip through `applyDelta`, every copy within the base and ≤ 64 KiB, every insert 1–127; 8.4 MB of targets as 104 KB of deltas; a 300 KB copy split into 5; empty source/target; `maxSize` gives up; git resolves a computed REF_DELTA. |
| R2 | Above: 0.88×, 0.88×, 0.93×, 0.99× git; the loose case installs in a native receiver (`--fix-thin` for thin) and passes `fsck`. |
| R3 | 0.85× git; `index-pack` and `fsck --strict` pass. |
| R4 | `a/settings.cfg` and `b/settings.cfg` among 30 unrelated blobs, window 2: delta'd against each other (path hash order). A 70-version file: every delta below git's max_size, depth ≤ 50. |
| R5 | Two 64 MiB blobs above a 16 MiB threshold: not delta'd, +0.6 MiB live. Window memory 600 KB: peak 422 KB with the current target (unbounded: 1.3 MB); 100 KB: text files not kept. Defaults, two similar 15 MiB blobs: delta'd, +63 MiB live, window ≤ 32 MiB + the target. |
| R6 | Windows 1, 4, 10: comparisons ≤ window × candidates. |
| R7 | The searched pack installs in X6b on the files and SQL backends; logs equal. |

### Mutation check

| Mutation | Caught by |
|---|---|
| S1 no path hash in the sort | R4 same-named pair (sizes 30 objects apart, window 2) |
| S2 no max_size bound | R4 bounds |
| S3 no explicit depth check | — equivalent: git's bound scales the budget by (depth − base depth), so a base at depth 50 gets 0 and is skipped (the check is redundant, as in git's try_delta) |
| S4 window size not enforced | R6 |
| S5 windowMemory not enforced | R5 window |
| S6 bigFileThreshold ignored | R5 big |
| S7 no preferred bases (thin) | R2 thin |
| E1 the encoder's early give-up removed | — equivalent in output (the final size check still returns undefined); it only saves work |
| E2 copies not split at 64 KiB | R1 split |
| E3 no backward extension | R1 sparse index |
| E4 git's sparse index (every 16th position) | R1 vs git's encoder (4.3×), R2, R3, R5 |
| F1 no check_delta_limit | #80: reused-delta children |
| F2 the writer ignores `depth` | #80: depth cuts reused chains |
| F3 encoder bound best − 1 instead of git's scaled bound | #80: the same base as git at depth 2 |
| F4 unreadable candidates not skipped | #80: corrupt first copy |
| F5 an entry larger than the window kept | R5: 100 KB window |
| F6 run dedupe keeping every other position | #80: run dedupe |
| F7 `\v` `\f` treated as spaces | #80: nameHash |
| F8 no same-size tie rule (shallower base) | — not covered: needs an exact size tie |

### Review of #80

| Finding | Resolution |
|---|---|
| A corrupt first copy failed the search export (X6d succeeds) | Candidates read verified; an unreadable one is left to X6d's writer |
| No check_delta_limit: a base pushed to depth 50 had its reused children demoted to whole | Reused-delta descendants lower the candidate's depth |
| `depth` did not bound the pack (the writer capped at 50) | The writer takes `depth` |
| The encoder got best − 1, not git's depth-scaled bound | git's scaled bound and tie rule |
| Memory: one oversized entry kept; index not counted at the peak; 256 MiB delta cache; "a DO stays within bounds" unsupported | Room made before indexing, oversized entries not kept, peak includes indexes; defaults 32/16/16 MiB; measured +63 MiB for 2 × 15 MiB |
| Run dedupe kept every other position | Only the first of a run |
| `\v` `\f` treated as spaces in the path hash | git's isspace: tab, LF, CR, space |
| Int32 positions limit sources to 2 GiB | Unreachable below `bigFileThreshold` (16 MiB default); noted |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/delta-encode.ts` | **Adopt** | git's delta format; denser index than git's for the same or smaller deltas |
| `src/export-search.ts` | **Adopt** | git's window search over X6d's writer |

## Open threads (ranked by how much later work they would invalidate)

1. **Transport**: smart-HTTP / httpeers negotiation (have/want/ACK, shallow, sideband) over these
   exports and X6b's ingest.
2. **Repack / gc (X18)**: the same search writes a repository's own packs (all objects, OFS_DELTA,
   `--depth`/`--window` from config); loose objects then stop growing.
3. **Search cost on large repositories**: one pass, no workers; index building is O(source) per
   window entry. Measure on a large history before adding workers (git: `--threads`).
4. OFS_DELTA output (smaller headers: ~2 %).
