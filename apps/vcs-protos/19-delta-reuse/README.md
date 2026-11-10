# 19 — Can export reuse what packs already hold — compressed entries and deltas — as git does?

Plan id **X6** (pack ingest/export), slice **X6d: delta reuse in export**. Status: **answered — yes: reusing stored entries and deltas brings the export to 1.05× git's pack (from 3.8×), every object copied as stored, CRC-checked, cycle-free; thin packs install in git and X6b.**

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

## Answer

**Yes.** `exportPackReusing(repo, wants, haves, { thin })` (and `writePackReusing` for a list)
decides, before writing, how each object goes out:

| stored as | sent as |
|---|---|
| a whole object in a pack | its compressed bytes after a fresh header — no inflate, no deflate |
| a delta (OFS or REF) whose base is also sent | the delta's compressed bytes as a `REF_DELTA` against that base |
| a delta whose base the receiver has (`thin`) | the same, against the receiver's object: a thin pack (`--fix-thin`, X6b's externalBase) |
| loose, or a delta whose base goes nowhere | inflated and deflated whole (X6c) |

- **Measured** (60 commits after `git gc --aggressive`): 90 692 bytes reused against 86 289 for
  `git pack-objects` (1.05×) and 332 280 whole (3.8×); all 420 objects copied as stored (174 whole,
  246 deltas), none deflated. A 64 MiB stored blob is copied at ~0 MiB extra, without a deflater.
- **Checked**: copied entries are CRC-checked against the idx as they stream (git checks before
  reusing); a mismatch fails the export with a PackError instead of passing corruption on — the
  bytes before the mismatch are already sent, so the consumer sees a failed (truncated) pack.
- **No cycles**: two packs can store A against B and B against A; the decisions are followed and
  an object on a cycle is sent whole.
- **Thin**: `HEAD ^HEAD~5` thin is smaller (11 386 vs 12 419 bytes) with deltas against the
  receiver's objects (the haves' and edges' trees, which X6c's walk now returns); a native receiver
  completes it with `index-pack --fix-thin`, X6b with its external base.
- **Parts added**: X6r's `PackReader.entry(oid)` / `ObjectDatabase.entry(oid)` (kind, size, base id
  — an OFS base resolved through the idx —, idx CRC, a CRC-checked raw stream); X16a's optional
  `ObjectStore.packedEntry`; X6c's walk returns `receiverHas`.

## Verified

All 6 Node tests pass (`pnpm test 19-delta-reuse`); X6r's, X16a's and X6c's suites pass with the
additions (64 tests). The tests were written first (red commit).

| # | Result |
|---|---|
| R1 | Above: git's object set, `index-pack` and `fsck --strict` pass, 1.05× git, 420/420 copied. |
| R2 | Thin smaller than non-thin, one delta against a receiver's object; native (`--fix-thin`) and X6b receivers install it, `fsck` passes, logs equal. |
| R3 | A byte flipped inside the pack: the export fails with a CRC error. |
| R4 | Pack 1 stores A against B, pack 2 B against A (both readable: X6r falls back to pack 2's whole A); the export holds no cycle and git installs it. |
| R5 | SQL backend: the packs in SqliteFilesApi reused (> 100 objects copied); the one loose row deflated. |
| R6 | 64 MiB stored whole: copied, peak ~0 MiB, no deflate. |

### Mutation check

| Mutation | Caught by |
|---|---|
| D1 the idx CRC not checked | R3 |
| D2 cycles not broken | R4 |
| D3 thin never used | R2 |
| D4 whole entries not reused | R1, R6 |
| D5 deltas not reused | R1 |
| D6 OFS bases not resolved to ids | R1 (an aggressive pack is OFS deltas) |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/export-reuse.ts` | **Adopt** | git's reuse; supersedes X6c's writer for packed objects |
| X6r `entry()`, X16a `packedEntry` | **Adopt** | raw entry access for export |

## Open threads (ranked by how much later work they would invalidate)

1. **Transport**: smart-HTTP / httpeers negotiation (have/want/ACK, shallow, sideband) over these
   exports and X6b's ingest.
2. **Delta search** for loose objects and whole entries (git's window over type, path hash, size):
   only matters where history arrives loose (commits made locally) — then repack (X18).
3. OFS_DELTA output (smaller headers than REF_DELTA's 20-byte ids: ~2 % here).
