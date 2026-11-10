# 12 — Can a pure-TS index-pack install real git packs byte-identically, in bounded memory, everywhere?

Plan id **X6** ("Streaming, resumable pack ingest/export"), first slice **X6a: index-pack**.
Status: **answered — yes: `.idx` byte-identical to git's for every pack tried, git reads what we install, corrupt packs leave nothing, a 64 MiB pack indexes in under 1 MiB of live memory.**

## Question

Clones and fetches deliver objects as a pack. git keeps the pack and writes an `.idx` next to it
(`git index-pack`): object ids (deltas resolved), CRC-32 per entry, offsets, the pack checksum.
webrun-vcs today explodes packs into loose objects through buffers. Can a pure-TypeScript
index-pack over FilesApi

- produce `.idx` v2 files **byte-identical** to `git index-pack` for real packs (OFS_DELTA and
  REF_DELTA, deep chains, a large blob),
- install the pack the way git does (temporary files, pack renamed first, idx last — a pack without
  idx is invisible to readers), so that native git reads the installed objects,
- refuse corrupt packs (truncated, bad trailer, broken zlib, out-of-range or missing delta bases)
  leaving nothing installed (quarantine), and
- keep memory bounded by the delta chain being resolved, not by the pack size,

on Node, in Chromium and in a Durable Object?

## Reject condition

Rejected if any `.idx` differs from git's for the same pack, native git cannot read an installed
pack, a corrupt pack leaves any file behind or installs a pack, or indexing a pack of large
incompressible objects needs memory proportional to the pack.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | For packs made by native git from a repository with history (≥ 300 objects, deltas): with OFS_DELTA (`--delta-base-offset`), with REF_DELTA (without), after `gc --aggressive` (deep chains), and a pack holding a 4 MiB incompressible blob, our `.idx` equals `git index-pack`'s byte for byte, and our object ids, offsets and CRCs equal `git verify-pack -v`'s. |
| R2 | A pack installed by us into an empty repository's `objects/pack/`: `git verify-pack`, `git fsck --full` and `git cat-file` of every object succeed. |
| R3 | Corrupt input — truncated, last byte of the trailer flipped, a byte inside a compressed entry flipped, an OFS_DELTA base offset pointing outside the pack, a REF_DELTA base absent (thin pack, not supported here), extra bytes after the trailer — is refused and leaves no file under `objects/pack/` (no pack, no idx, no temporary). |
| R4 | Memory: indexing a pack of 64 incompressible 1 MiB blobs (64 MiB) holds < 16 MiB live (heap + array buffers), sampled inside the reads. |
| R5 | Runtimes: a committed fixture pack is indexed byte-identically to git's committed `.idx` in Chromium (OPFS) and in a Durable Object (SqliteFilesApi). |
| R6 | Delta application refuses malformed deltas (base size mismatch, copy beyond the base, result size mismatch, truncated instructions, instruction 0) instead of reading out of bounds. |

## Scope — what this slice does NOT do

- Thin packs (`--fix-thin`: appending local bases) — X6b.
- Resumable, time-sliced indexing for Durable Objects — X6b.
- Exploding packs into SQL with batched transactions — X6b.
- Pack export / pack-objects — X6c. No `.rev` files (git writes them by default since 2.31;
  they are optional caches).

## Answer

**Yes.** `installPack(files, "objects/pack", stream)` — about 410 lines on FilesApi, plus a 66-line delta applier and an 18-line CRC-32 — follows git's
index-pack: store the stream as `tmp_pack_*`, one sequential pass (entry headers, delta bases,
every zlib stream inflated once with exact ends, CRC-32 of each entry, ids of non-delta objects,
trailer), delta resolution from each base down to its children by re-reading entries by offset,
an `.idx` v2, then rename the pack and — last — the idx into place.

- Its `.idx` equals `git index-pack`'s byte for byte for OFS_DELTA and REF_DELTA packs of a
  60-commit history, a `gc --aggressive` pack, and a pack with a 4 MiB incompressible blob plus a
  delta against it; ids, offsets and CRCs match `git show-index` for every entry.
- Native git reads an installed pack (`verify-pack`, `fsck --full`, `cat-file` of every object).
- Seven kinds of corrupt input are refused with `PackError` and leave `objects/pack/` empty.
- A 64 MiB pack of incompressible blobs is indexed with +0.6 MiB live: memory follows the delta
  chain being resolved, never the pack.
- The same code indexes the fixture byte-identically in Chromium (OPFS) and in a Durable Object
  (SqliteFilesApi).

Findings:

1. **Two passes over local storage, one over the network.** git's index-pack parses while
   writing; here the stream is written first (streaming) and parsed by a sequential read, which
   keeps the parser a plain loop over FilesApi and costs one extra local read. Deltas then need
   random access to the stored pack anyway (FilesApi `read({ start, length })` on every backend).
2. **The idx is the commit point.** git readers only see packs through their `.idx`, so writing the
   pack first and the idx last gives quarantine for free: a crash leaves at most a pack without idx
   (or temporaries), which `git gc` cleans and our reader ignores. On failure we remove both.
3. **Bases are inflated only if they have children**, and children are resolved depth first with
   an explicit stack (aggressive packs chain deeply); a 4 MiB base and its delta child are held
   together while resolving, which is the memory bound — not the pack size.
4. **The delta applier checks every bound** (base size, copy range, result size both ways,
   truncated operands, the reserved instruction 0). The vcs-utils applier the plan flagged in X1
   does not; this one is 66 lines, after git's `patch-delta.c` and JGit's `BinaryDelta`.
5. **The expected pack length comes from the stored file**, so "bytes after the trailer" fails the
   length check before the explicit end-of-stream check (an equivalent mutant, M9).
6. **Thin packs are refused** with a clear error (REF_DELTA bases outside the pack); fixing them
   (`--fix-thin`, appending local bases and rewriting the trailer) is X6b, as are resumable steps
   for Durable Objects and exploding packs into SQL in batched transactions.

## Verified

All 24 Node tests and 1 Chromium test pass (`pnpm test 12-index-pack`).

| # | Result |
|---|---|
| R1 | Four packs made by native git (OFS_DELTA; REF_DELTA; `gc --aggressive`; a 4 MiB incompressible blob with a one-byte-changed version as a delta): `.idx` byte-identical to `git index-pack`'s; every entry's id and CRC equal `git show-index`'s at its offset; > 300 entries for the history packs. |
| R2 | Installed into an empty repository: `pack-<id>.pack` and `pack-<id>.idx` only; `git verify-pack`, `git fsck --full` pass; `git cat-file` of every object equals the source repository's. Renames happen pack first, idx last (R2b). |
| R3 | Refused with `PackError`, `objects/pack/` left empty: truncated; trailer byte flipped; a compressed byte flipped; an entry's declared size disagreeing with its data (trailer recomputed); an OFS_DELTA base before the pack; a thin pack (REF_DELTA bases absent); bytes after the trailer. |
| R4 | 64 MiB pack of 64 incompressible 1 MiB blobs: +0.6 MiB live (heap + array buffers after GC, sampled inside 8 195 reads of the stored pack). |
| R5 | The committed fixture (40-commit history, 51 KB pack) indexes to git's committed `.idx` byte for byte in Chromium on OPFS and in a Durable Object on SqliteFilesApi. |
| R6 | The delta applier applies a copy+insert delta and refuses base-size mismatch, copy beyond the base, result longer or shorter than declared, truncated insert, truncated copy operands, instruction 0. |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 CRC computed without the entry header | R1 (4), R2, R4 |
| M2 trailer not checked | R3 trailer flipped |
| M3 inflated size not compared with the header | R3 declared-size case (added: the first contract had no case where only this check could fire) |
| M5 delta copy bound not checked | R6 copy beyond the base |
| M7 temporaries kept on error | R3 (6 tests) |
| M8 OFS_DELTA base not validated in phase 1 | equivalent: the delta stays unresolved and phase 2 refuses the pack |
| M9 bytes after the trailer accepted by the end check | equivalent: the stored length already fails the trailer position check |
| M10 unresolved deltas not reported | R3 thin pack |
| M11 fan-out shifted by one | R1 (4), R2, R4 |
| M12 idx renamed before the pack | R2b |
| M13 base content corrupted between children | R1 (4), R2 |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| Plan: ingest strategy per backend is open | For FilesApi backends (Node, OPFS, SqliteFilesApi in a DO) git's own model — keep the pack, write an idx — works unchanged and is byte-compatible; exploding into objects is only needed for the native SQL store (X6b). |
| vcs-utils' delta code can be reused | It lacks bounds checks; a 66-line checked applier is smaller than fixing it. |

## Functional description

```ts
const { packId, entries, idx } = await installPack(files, "/objects/pack", stream);
// files: any FilesApi with streaming write, ranged read, stats, move, remove
```

## Interfaces produced

```ts
function installPack(files: FilesApi, packDir: string, source: AsyncIterable<Uint8Array>): Promise<{ packId; entries; idx }>;
function writeIdx(entries: { oid; offset; crc32 }[], packId: string): Uint8Array;   // .idx v2
function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array;               // checked
class PackError extends Error {}
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/index-pack.ts`, `src/delta.ts`, `src/crc32.ts` | **Adopt** | git-compatible pack ingest for every FilesApi backend |
| `src/git-repo.ts`, `scripts/make-fixture.ts` | **Source** | native-git pack fixtures for tests |
| `src/do-entry.ts` | **Source** | DO harness |

## Open threads (ranked by how much later work they would invalidate)

1. **X6b**: thin packs (`--fix-thin`), resumable time-sliced indexing for Durable Objects (state:
   parsed entries + resolution frontier), and exploding a pack into the native SQL store in
   batched transactions (X3b's open thread).
2. **Reading objects from packs** (idx binary search, offset → inflate, delta chains with a base
   cache) behind X4's kernel interface — needed before loose objects can stop being the default.
3. **X6c**: pack export (pack-objects) with credit-based backpressure and cancel.
4. `.rev` files and pack bitmaps (optional caches in git).
