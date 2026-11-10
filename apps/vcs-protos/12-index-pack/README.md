# 12 — Can a pure-TS index-pack install real git packs byte-identically, in bounded memory, everywhere?

Plan id **X6** ("Streaming, resumable pack ingest/export"), first slice **X6a: index-pack**.
Status: **answered — yes: `.idx` byte-identical to git's for every pack tried (and git's refusal for every pack git refuses), git reads what we install, corrupt and hostile packs leave nothing; memory follows the delta chain being resolved, bounded by a base cache, not the pack.**

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

**Yes.** `installPack(files, "objects/pack", stream, { maxObjectSize, baseCacheBytes })` follows
git's index-pack on FilesApi: store the stream as `tmp_pack_*`, one sequential pass (entry headers,
delta bases, every zlib stream inflated once with exact ends — and stopped at the first byte past
the declared size — CRC-32 of each entry, ids of non-delta objects, trailer), delta resolution from
each base down to its children re-reading entries by offset, an `.idx` v2, then rename the pack and
— last — the idx into place.

- Its `.idx` equals `git index-pack`'s byte for byte for OFS_DELTA and REF_DELTA packs of a
  60-commit history, a `gc --aggressive` pack, a pack with a 4 MiB incompressible blob plus a delta
  against it, and 11 hand-built packs git never writes itself; for every hand-built pack git
  refuses (count mismatches, REF cycles, duplicate bases, a base before the pack) we refuse too.
- Native git reads an installed pack (`verify-pack`, `fsck --full`, `cat-file` of every object).
- Corrupt and hostile input is refused with `PackError` and leaves `objects/pack/` empty: a 64 MiB
  inflate bomb stops at its first extra byte (30 ms; git: 12 ms), a delta declaring 4 GiB or 1 TiB
  is refused before anything is allocated, objects over `maxObjectSize` are refused by header.
- Memory: a 4 MiB base with a 50-deep chain resolves in +4–9 MiB live (the first version held the
  whole chain: +200 MiB); bases beyond `baseCacheBytes` are evicted and re-derived; a 64 MiB pack of
  incompressible blobs indexes in +0.3–0.8 MiB.
- Chromium (OPFS) and a Durable Object (SqliteFilesApi) index the fixture byte-identically.

Findings:

1. **Delta memory needs git's base cache, not a plain stack.** Holding every ancestor while
   descending cost depth × object size (review blocker: a 4 MB pack with a 50-deep chain needed
   +200 MiB, beyond a DO). Now a frame whose children are all taken is released before its last
   child is descended into (a linear chain holds base + result), frames below the top keep content
   only within `baseCacheBytes` (default 32 MiB), and an evicted base is re-derived along its own
   base links — git's `delta_base_cache_limit` with `prune_base_data`/`get_base_data`.
2. **Hostile sizes must never drive allocation or work.** Delta application first walks all
   instructions, checking every bound and summing the output, and allocates only if that equals the
   declared size and is within `maxObjectSize` (default 1 GiB); inflation stops at the first byte
   past an entry's declared size (a 510 KB pack inflating to 512 MiB took 5 s of CPU before).
   Allocation failures are not disguised as format errors.
3. **Two passes over local storage, one over the network**; deltas need random access to the stored
   pack anyway. Each delta is a fresh ranged read (a stat/open/close on Node): 1.9 s against git's
   0.25 s for a 4.6 MB, 5 000-object pack — fine for the prototype, a target for X6b.
4. **The idx is the commit point** (pack renamed first, idx last); readers never see a pack without
   its idx, failures remove both temporaries, and the read of the stored pack is released even when
   parsing fails (otherwise Windows could not delete the temporary). Node writes are fsync'ed before
   the renames (git fsyncs packs); SqliteFilesApi commits transactionally and OPFS on `close()`.
5. **Duplicate bases follow git**: a delta reachable from two bases with the same id is refused
   ("already resolved (duplicate base)"); plain duplicate objects index exactly as git does.
6. **Limits for X6b**: about 0.9 KB of heap per entry (entry objects, maps) — a pack of 200 000
   objects peaks near +170 MiB, so a Durable Object tops out around 100–150 thousand objects until
   entries move to typed arrays; thin packs are refused; SHA-1 without collision detection and no
   check against objects already in the repository (git's `check_collision`).

## Verified

All 42 Node tests and 1 Chromium test pass (`pnpm test 12-index-pack`).

| # | Result |
|---|---|
| R1 | Four packs made by native git (OFS_DELTA 245 deltas; REF_DELTA 245; `gc --aggressive`; a 4 MiB blob with a delta child; chains up to 40): `.idx` byte-identical to `git index-pack`'s, every id and CRC equal `git show-index`'s. R1b: 11 hand-built packs — zero objects, v3, count too high/low, the same blob twice, REF on REF, forward REF, OFS on REF, REF cycle, duplicate base, base before the pack — give git's idx or git's refusal. Large offsets (> 2³¹, up to 2⁴⁰) in `writeIdx` decode through `git show-index`. |
| R2 | Installed into an empty repository: `pack-<id>.pack` and `.idx` only; `verify-pack`, `fsck --full` pass; `cat-file` of every object equals the source; pack renamed before idx (R2b). |
| R3 | Refused with `PackError`, `objects/pack/` empty: truncated; trailer flipped; a compressed byte flipped; a declared size disagreeing with the data (trailer recomputed); an OFS_DELTA base inside the pack but not at an entry; a thin pack; bytes after the trailer. R3b: a delta declaring 4 GiB (live memory < +64 MiB) and, with no size limit, 1 TiB — refused before allocating; a 10-byte entry inflating to 64 MiB refused in < 200 ms; `maxObjectSize` refuses by header. |
| R4 | 64 MiB of incompressible blobs (no deltas: phase 1 only): +0.3–0.8 MiB live. R4b (live memory sampled on every read): a 4 MiB base with a 50-deep linear chain: +4–9 MiB; a two-level tree (4 MiB base → 3 deltas → 3 chains of 3) with a 1-byte and a 64 MiB base budget: idx identical, < 24 MiB, and the base inflated once with the large budget but re-derived several times with the 1-byte one. |
| R5 | The committed fixture indexes to git's committed `.idx` in Chromium (OPFS) and a Durable Object (SqliteFilesApi). |
| R6 | The delta applier refuses base-size mismatch, copy beyond the base, result longer or shorter than declared, truncated insert or copy operands, instruction 0. |

### Mutation check

All re-run against the final code. (M4 and M6 were not used as numbers.)

| Mutation | Caught by |
|---|---|
| M1 CRC computed without the entry header | R1 (4), R2, R4 |
| M2 trailer not checked | R3 trailer flipped |
| M3 inflated size not compared with the header | R3 declared-size case |
| M5 delta copy bound not checked | R6 |
| M7 temporaries kept on error | R3 (6 tests) |
| M8 OFS_DELTA base not validated in phase 1 | equivalent: the delta stays unresolved and phase 2 refuses the pack |
| M9 bytes after the trailer accepted by the end check | equivalent: the stored length already fails the trailer position check (the end check is a guard against a file changing after `stats`) |
| M10 unresolved deltas not reported | R3 thin pack |
| M11 fan-out shifted by one | R1, R2, R4 |
| M12 idx renamed before the pack | R2b |
| M13 base content corrupted between children | R1, R2 |
| N1 parent frame not released before descending | R4b linear chain and tree |
| N2 base cache budget ignored | R4b tree (base read once instead of re-derived) |
| N3 inflation not stopped past the declared size | R3b bomb timing |
| N4 delta result allocated before validation | R3b 1 TiB case |
| N5 duplicate base accepted | R1b duplicate base |
| N6 `maxObjectSize` not checked | R3b |
| N7 re-derivation skips the delta chain | R4b tree (idx differs) |
| N8 read not released when parsing fails | not asserted: the mutated run hung on the open file handle (Node also warns "closing file descriptor on garbage collection") |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| First version: "memory bounded by the delta chain … a base and its child are held together" | The whole chain was held (+200 MiB for 50 × 4 MiB); the 64 MiB test pack had no deltas and measured phase 1 only. Fixed with early release and a base cache. |
| First version: "follows git" for every pack | Duplicate bases were accepted where git refuses; now refused. |
| A pure-TS index-pack is safe against hostile packs because it checks sizes | Only if sizes are checked before allocating and inflation stops at the declared size. |
| Plan: ingest strategy per backend is open | For FilesApi backends git's own model — keep the pack, write an idx — works unchanged; exploding into objects is only needed for the native SQL store (X6b). |
| vcs-utils' delta code can be reused | It lacks bounds checks; a checked applier is about 80 lines. |

## Functional description

```ts
const { packId, entries, idx } = await installPack(files, "/objects/pack", stream, {
  maxObjectSize: 2 ** 30,     // refuse larger objects and delta results
  baseCacheBytes: 32 * 2 ** 20, // resolved bases kept while resolving deltas
});
```

## Interfaces produced

```ts
function installPack(files: FilesApi, packDir: string, source: AsyncIterable<Uint8Array>,
  opts?: { maxObjectSize?: number; baseCacheBytes?: number }): Promise<{ packId; entries; idx }>;
function writeIdx(entries: { oid; offset; crc32 }[], packId: string): Uint8Array;   // .idx v2
function applyDelta(base: Uint8Array, delta: Uint8Array, maxSize?: number): Uint8Array;
class PackError extends Error {}
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/index-pack.ts`, `src/delta.ts`, `src/crc32.ts` | **Adopt** | git-compatible pack ingest for every FilesApi backend (imports X1d's inflater by path: package before promotion) |
| `src/craft.ts`, `src/git-repo.ts`, `scripts/make-fixture.ts` | **Source** | hand-built and native-git pack fixtures |
| `src/do-entry.ts` | **Source** | DO harness |

## Open threads (ranked by how much later work they would invalidate)

1. **X6b**: thin packs (`--fix-thin`), resumable time-sliced indexing for Durable Objects, entries in
   typed arrays (100k+ objects in a DO), exploding a pack into the native SQL store in batched
   transactions, one open reader for all delta loads.
2. **Reading objects from packs** (idx lookup, offset → inflate, delta chains with this base cache)
   behind X4's kernel interface.
3. **X6c**: pack export (pack-objects) with credit-based backpressure and cancel.
4. SHA-1 collision detection and `check_collision` against existing objects before promotion.
