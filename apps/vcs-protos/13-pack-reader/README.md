# 13 — Can objects be read from installed packs (and loose objects) as native git reads them, in bounded memory, everywhere?

Plan id **X6** (pack ingest/export), slice **X6r: reading packs**. Status: **answered — yes, with one criterion corrected: every object equals `git cat-file`, corruption is caught, large blobs stream; delta memory is the cache budget plus a working set of a few objects (the "< 24 MiB" bound forgot the working set).**

## Question

X6a installs packs (`pack-<id>.pack` + `.idx`) exactly as git does, but nothing reads objects out
of them yet: after a clone, the repository is only usable through native git. Can a pure-TS object
database over FilesApi — loose objects through X4's kernel plus every installed pack — return every
object byte-identically to `git cat-file`, with

- idx lookups as git's (fan-out + binary search, large offsets), validation of idx and pack
  checksums on open,
- delta chains (OFS and REF) resolved through a byte-bounded base cache (git's `delta_base_cache`),
- large non-delta objects streamed without materialising them,
- corruption detected (bad idx checksum, pack/idx mismatch, broken entry, wrong hash with
  `verify`),

on Node, in Chromium and in a Durable Object?

## Reject condition

Rejected if any object differs from `git cat-file`'s, a corrupt idx or a pack/idx mismatch is
accepted, reading a delta-heavy pack needs memory proportional to the pack or to chain depth ×
object size beyond the cache budget, or streaming a 64 MiB packed blob holds it in memory.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | For every object of packs made by native git (OFS_DELTA, REF_DELTA installed through X6a, `gc --aggressive`, a 4 MiB blob with a delta child), type, size and content equal `git cat-file --batch`. |
| R2 | An object database over a repository with objects split across loose files and two packs reads every object; an absent id returns `undefined`; `has` agrees; `list` yields every id once. |
| R3 | Opening a pack whose idx checksum is wrong, whose idx names another pack (trailer mismatch) or whose idx is truncated fails with `PackError`; reading an entry whose compressed bytes are corrupt fails with `PackError`; `verify: true` detects content that hashes to another id. |
| R4 | Reading every object of a 4 MiB base + 50-deep chain pack in random order holds < 24 MiB live with a 16 MiB base cache; with the cache, the number of entry inflations is at most half of what it is without. |
| R5 | In Chromium (OPFS) and a Durable Object (SqliteFilesApi): every object of X6a's fixture pack is read with `verify: true` (its content hashes to its id). |
| R6 | A 64 MiB incompressible blob stored in a pack without delta is streamed with < 16 MiB live. |

## Scope — what this slice does NOT do

- No multi-pack index (`multi-pack-index`), no `.rev` or bitmap files.
- No writing (X6a installs, X4 writes loose objects); no repacking or gc (X18).

## Answer

**Yes.** `openPack(files, pack, idx)` and `openObjectDatabase(files, "/.git/objects")` read every
object of native-git packs byte-identically to `git cat-file` — OFS_DELTA, REF_DELTA (installed by
X6a), `gc --aggressive`, a 4 MiB blob with a delta child — and of a repository whose objects are
split across loose files and two git-written packs; Chromium (OPFS) and a Durable Object
(SqliteFilesApi) read X6a's fixture pack with every object verified.

- Open validates the idx completely (magic, version, monotonic fan-out, exact length with the
  large-offset table, its own SHA-1) and that the pack's trailer is the checksum the idx records;
  lookups are fan-out + binary search; each entry is read with one ranged read of exactly its bytes
  (its end is the next offset in pack order — git's reverse index, built on first need).
- Non-delta objects stream straight from the inflater: a 64 MiB blob is read with +0.0–0.2 MiB live.
- Delta chains resolve down to a non-delta base or a cached object and patch upwards with X6a's
  checked applier, through a byte-bounded LRU of resolved objects (git's `delta_base_cache`).
- Corrupt entries raise `PackError`; `verify: true` re-hashes and catches bytes that are a valid
  object of another id.

Findings:

1. **Cache checkpoints, not every step.** Caching every object resolved along a chain lets the top
   of the last chain evict everything else: random reads of a 50-deep chain over 4 MiB with a
   16 MiB cache cut inflations only from 1 326 to 803. Spreading the cache's slots evenly along
   the chain (plus the object asked for) gives 631 — fewer than half — and 371 when reading the
   deepest objects first (a history walk); a 64 MiB cache gives 339 / 140. A cache that fits one
   object (8 MiB here) barely helps (862 / 1 326): it can only hold the last answer.
2. **Delta memory = cache budget + working set.** Resolving holds the base being patched, the new
   result and the caller's previous object, plus buffers awaiting release: the no-cache run already
   peaks at +24 MiB for 4 MiB objects, the 16 MiB cache at +30–34 MiB. The criterion's "< 24 MiB
   with a 16 MiB cache" ignored the working set: **not met as written**; the test asserts
   budget + 5 objects instead.
3. **The pack/idx pairing must be checked by trailer**: an idx of another pack with the same
   object count passes every other check (count, lengths) and would serve wrong offsets.
4. **Packs first, then loose objects** (git's order); REF_DELTA bases outside a pack resolve
   through the whole database (thin packs are refused by X6a, so git-written packs never need it —
   untested here).

## Verified

All 12 Node tests and 1 Chromium test pass (`pnpm test 13-pack-reader`).

| # | Result |
|---|---|
| R1 | OFS_DELTA (60-commit history), REF_DELTA, `gc --aggressive`, a 4 MiB blob with a delta child, installed by X6a: for every object, type, size and content equal `git cat-file --batch-all-objects --batch`. |
| R2 | Objects in two git-written packs (`repack -d` twice) plus loose objects: every object read (with `verify`) equals git's; `has` true for all, `list` yields each id once and exactly git's set; an absent id: `has` false, `get` undefined. |
| R3 | Open refuses with `PackError`: idx checksum flipped; another pack's idx (different count); another pack's idx with the same count (trailer check only); truncated idx. A flipped byte inside a compressed entry fails the read with `PackError`; a pack whose bytes are another valid object under the same layout is served without `verify` and refused with it. |
| R4 | 4 MiB base + 50-deep chain, all 51 objects in random order, each verified: 16 MiB cache → 631 inflations (no cache: 1 326), peak +30–34 MiB live (no cache: +24 MiB). |
| R5 | Chromium (OPFS) and a Durable Object (SqliteFilesApi): all 280 objects of X6a's fixture read with `verify`. |
| R6 | A 64 MiB incompressible blob in a git-written pack: streamed with +0.0–0.2 MiB live, its SHA-1 equals its id. |

### Mutation check

| Mutation | Caught by |
|---|---|
| P1 idx checksum not checked | R3, R4 |
| P2 pack/idx mismatch accepted (trailer check removed) | R3 same-count idx (added: the first R3 case was also caught by the object count) |
| P3 fan-out lower bound off by one | R1 (4), R2, R3 |
| P6 every resolved step cached (no checkpoints) | R4 inflation count |
| P8 `verify` ignored | R3 forged pack |
| P11 `has` ignores packs | R2 |
| P12 non-delta objects materialised instead of streamed | R6 (after sampling the first chunk too: one huge chunk was never sampled) |

Not tested: offsets above 2 GiB in a real pack (X6a tests the idx encoding), REF_DELTA bases in
another pack or loose.

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| Criterion R4: "< 24 MiB live with a 16 MiB cache" | Unattainable as written: resolving needs a working set of a few objects on top of the cache (+24 MiB with no cache at all). |
| An LRU of every resolved object is git's delta base cache | For one deep chain it thrashes; spacing cached objects along the chain halves the work. |

## Functional description

```ts
const db = await openObjectDatabase(files, "/.git/objects", { baseCacheBytes: 16 * 2 ** 20 });
const o = await db.get(oid, { verify: true });   // { type, size, content: AsyncIterable<Uint8Array> }
```

## Interfaces produced

```ts
function openPack(files: FilesApi, packPath: string, idxPath: string,
  opts?: { baseCacheBytes?: number; externalBase?: (oid) => Promise<{ type; data } | undefined> }): Promise<PackReader>;
interface PackReader { packId; count; has(oid); get(oid, { verify? }); ids(); stats: { inflations } }
function openObjectDatabase(files: FilesApi, objectsDir: string, opts?): Promise<{ get; has; list }>;
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/pack-reader.ts` | **Adopt** | reading git packs on every FilesApi backend |
| `src/object-db.ts` | **Adopt** | git's object database (packs + loose) behind X4's read shape |
| `src/do-entry.ts` | **Source** | DO harness |

## Open threads (ranked by how much later work they would invalidate)

1. **One object-store interface** for writing (X4 loose, X3b SQL) and reading (packs + loose, SQL):
   the Repository façade (X16) needs a single `ObjectStore`.
2. **multi-pack-index**, `.rev` files and bitmaps for repositories with many packs (git's caches).
3. Packs in the native SQL store (X6b) — reading them through the same interface.
4. A persistent cache across readers and a shared inflater per pack read (one open read per entry
   today).
