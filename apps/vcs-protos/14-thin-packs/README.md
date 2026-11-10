# 14 — Can index-pack complete thin packs from the local repository and index 100k+ objects in a Durable Object's memory?

Plan id **X6** (pack ingest/export), slice **X6b1: thin packs, compact entries, bounded reads,
temporaries**. Status: **answered — yes: thin packs complete to git's objects and order, 200 000 entries in +14 MiB, one storage read serves a pack's delta loads, stale temporaries swept; appended bases are compressed by pako, so the completed pack is git-equivalent, not byte-identical.**

## Question

X6a's `installPack` refuses thin packs — the packs every `git fetch` receives, whose REF_DELTA
bases are objects the receiver already has (`git pack-objects --thin`). It also holds about 0.9 KB
of heap per entry (+170 MiB for 200 000 objects: too much for a 128 MiB Durable Object), reads each
delta back with its own storage read, and never removes the `tmp_*` files an interrupted install
leaves behind. Can index-pack, as git's `index-pack --fix-thin`,

- resolve the missing bases from the local object database (X6r), append them to the pack as
  whole objects, rewrite the header count and the trailer, and install the completed pack,
- keep its per-entry state in typed arrays, so 200 000 objects fit in a few tens of MiB,
- serve phase-2 reads from a bounded window over the stored pack instead of one read per delta,
- sweep stale temporaries as `git prune` does,

without giving up anything X6a verified (git-identical `.idx`, refusals of hostile packs)?

## Reject condition

Rejected if a completed thin pack holds other objects than git's `index-pack --fix-thin` makes of
it or fails `git verify-pack` / `git fsck`, if a base whose content does not hash to the requested
id is accepted, if any of X6a's native-git packs no longer indexes to git's `.idx`, or if 200 000
entries still need memory of the order of X6a's.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Thin packs made by `git pack-objects --thin` (REF_DELTA and `--delta-base-offset`; an incremental range of a history repository; a 4 MiB blob edited by one byte), installed with `externalBase` reading the receiver's object database (X6r): the installed pack holds exactly the objects of `git index-pack --fix-thin`'s, appended bases in git's order with git's types; the entries of the received pack keep their offsets and CRC-32 as in git's index; the pack is named after the SHA-1 of its final content, passes `git verify-pack` and `git fsck --full`, and `git cat-file` reads every object. |
| R1b | A thin pack is refused with `PackError` and nothing installed when no `externalBase` is given (X6a's behaviour), when a base is unknown (the message counts the unresolved deltas), or when `externalBase` returns content that hashes to another id. A REF_DELTA whose base is itself the result of a thin delta resolves without another lookup; a base wanted by several deltas is appended once. |
| R2 | Every X6a native-git pack (OFS, REF, `gc --aggressive`, 4 MiB blob with a delta child) still indexes to an `.idx` byte-identical to `git index-pack`'s; hostile packs are still refused (X6a's R3/R3b cases re-run against this implementation). |
| R3 | A 200 000-object pack (with OFS and REF deltas) installs with < 40 MiB extra live memory (heap + array buffers, sampled after GC on every storage read) and an `.idx` identical to git's. |
| R4 | A pack header that declares more entries than the pack's size can hold is refused before anything is allocated. |
| R5 | Phase 2 reads the stored pack through a bounded window: for the 60-commit history pack (245 deltas; first written "≥ 300", a miscount — X6a records 245) the number of storage reads is at most a quarter of the number of delta loads. |
| R6 | `sweepPackTemporaries(files, packDir, { olderThanMs })` removes `tmp_*` files in the pack directory older than the threshold (git prune's rule), keeps younger ones and never touches `pack-*` files. |
| R7 | In Chromium (OPFS) and a Durable Object (SqliteFilesApi) a committed thin-pack fixture is completed from committed base objects to the same pack and `.idx` as on Node. |

## Scope — what this slice does NOT do

- Resumable, time-sliced indexing across Durable Object requests — X6b2.
- Exploding packs into the native SQL store — X6b3.
- `check_collision` against objects already present and SHA-1 collision detection.

## Answer

**Yes.** `installPack(files, packDir, stream, { externalBase })` completes thin packs as
`git index-pack --fix-thin` does, and the rewritten index-pack keeps everything X6a verified (its
whole Node suite passes against this module).

- **Thin packs.** After phase 2, the REF_DELTAs still unresolved are walked in pack order (git's
  `fix_unresolved_deltas`); each missing base id is asked for once (a miss is remembered; git
  asks again per delta), must hash to the requested id, is appended as a whole object (pako, zlib
  level 6, kept as the deflater's chunks) and its subtree is resolved at once — a delta on
  a thin delta's result needs no lookup, a base shared by several deltas is appended once. The pack
  is then rewritten with the new count and a new trailer (`fixup_pack_header_footer`); while the
  received part is copied it is re-hashed with its original header and must still match its
  trailer. For four `pack-objects --thin` packs (REF, OFS, one commit, a 4 MiB blob edited by one
  byte) the completed pack holds git's objects, appends git's bases in git's order with git's
  types, keeps every received entry's offset and CRC as in git's index, is named after its own
  SHA-1, has the `.idx` git computes for it, and passes `verify-pack`, `fsck --full` and `cat-file`.
- **Appended entries are not byte-identical to git's**: git compresses them with its own zlib
  settings (a 22 893-byte blob: 4 785 bytes from git 2.43, 4 637 from pako or Node's zlib at the
  default level), so the pack id differs from git's for the same thin pack. Both are valid; nothing
  downstream depends on the id beyond naming the files.
- **Compact entries.** Per-entry state is struct-of-arrays — offsets, sizes, CRC, kind, type,
  header length, base index, id and REF base id: 75 bytes an entry (plus 12 for the child links
  and stack positions during phase 2, 4 for the idx sort order). OFS children are linked lists in
  two `Int32Array`s, REF children a sorted index searched by id, and a resolved delta records the
  entry it was resolved against, so re-deriving an evicted base follows indices, not maps. A
  200 000-object pack (half OFS/REF deltas) installs with a peak of +18.7 MiB live and git's
  `.idx` (X6a: +135 MiB, table below).
- **Only parsed entries earn memory.** A header declaring more entries than `(size − 32) / 9`
  (the smallest entry: a 1-byte header and an 8-byte zlib stream) is refused at once; below that,
  the tables start at 4 096 entries and grow as entries are parsed — towards the count the bytes
  parsed so far predict, but by 1.25×–2× a step — so a 16 MiB pack declaring 1.86 million entries
  with garbage after 100 000 valid ones is refused at +9.6 MiB (+110 MiB when the tables were
  allocated from the header: found by the review).
- **The resolution stack is typed arrays** (entry, type, two child cursors: 17 bytes a level) and
  one content slot per level; cached contents count 96 bytes of object overhead against the
  budget. A 100 000-deep comb (a REF chain with an OFS leaf on every node) peaks at +22–24 MiB
  with a 2 MiB cache (+68 MiB with a frame object, array and Map entry per level: the review).
- **Bounded window.** Phase 2 re-reads entries through one window (default 1 MiB, never two held):
  an entry inside it costs no storage read, a miss refills it from that entry on, entries over half
  the window are streamed directly. The 60-commit history pack's 254 entry loads take 1 storage
  read (X6a: 254).
- **Appended entries are batched**: a fetch needing hundreds of bases writes ~1 MiB `tmp_thin_*`
  files (an entry over 1 MiB alone), the batch being filled is read from memory; an evicted
  appended base is re-read from its batch (tests for both paths, which the review found
  untested). The table grows once, by the number of distinct missing ids.
- **Temporaries.** `sweepPackTemporaries(files, packDir, { olderThanMs, now? })` removes the
  `tmp_*` files of the pack directory older than the threshold — git prune's rule; young ones may
  belong to an install in progress — and never touches `pack-*` or other files.
- Chromium (OPFS) and a Durable Object (SqliteFilesApi) complete the committed fixture thin pack
  (2 286 bytes, 4 bases) to the committed `.idx` (18 objects).

## Verified

All 24 Node tests, the 45 X6a tests re-run against this module and 1 Chromium test pass
(`pnpm test 14-thin-packs`).

| # | Result |
|---|---|
| R1 | Four thin packs (REF_DELTA and OFS_DELTA: last 5 of 30 commits; one commit; a 4 MiB blob with a one-byte edit) completed with `externalBase` over the receiver's object database (X6r): same object set as `git index-pack --fix-thin`, appended bases equal in order and type, received entries' offsets and CRCs equal git's, pack named after its trailer, `.idx` equal to git's for our pack, `verify-pack`, `fsck --full`, `cat-file` of every object equal to the sender's. |
| R1b | Refused with `PackError`, nothing left in the pack directory: no `externalBase`; unknown base ("2 unresolved deltas", asked once for two deltas); a base hashing to another id. A REF on a thin delta's result: one lookup, one appended base, 4 objects; a complete pack never calls `externalBase` and keeps its id. |
| R2 | X6a's suite (45 tests: four native-git variants with git-identical `.idx`, 11 crafted packs, corrupt and hostile packs, memory on deep and branching chains, large offsets, the delta applier) passes with X6a's module replaced by this one (`vi.mock`). Its DO test bundles X6a's own harness with esbuild, which `vi.mock` does not reach: it still runs X6a's module; this slice's DO run is R7. X6a's two-level-tree memory bound was loosened from 24 to 48 MiB: in the full suite it read +24–42 MiB on X6a's module as on this one (+8 MiB alone); its deterministic check (the base read 9× with a 1-byte budget, once with 64 MiB) is unchanged. |
| R3 | 200 000 objects: peak +18.7 MiB live (sampled after two GCs on every storage read), `.idx` identical to git's. R3b: the declared-count pack above refused at +9.6 MiB; the 100 000-deep comb (2 MiB cache, sampled every 500 of its 523 588 reads with a 64-byte window) +22–24 MiB, `.idx` identical to git's. Memory is sampled after two forced collections: after one, V8's concurrent ArrayBuffer sweeper still counted freed tables (the comb read 27, then 45 MiB on two identical runs). |
| R4 | A header declaring 2³²−1 entries in a one-entry pack: refused, < 16 MiB live. |
| R5 | 254 entry loads, 1 storage read (+1 for phase 1); `.idx` identical to git's. The criterion first said "≥ 300 deltas": the pack has 245 (X6a's count). R5b: with a 4 KiB window over the same pack, no storage read is longer than the window (a whole-file refill, the review's mutation, fails it). |
| R6 | Node: `tmp_pack_old`, `tmp_idx_old` (3 days) removed with a 1-day threshold; `tmp_pack_young`, an old `garbage.txt` and old `pack-*` kept. MemFilesApi: kept at `now`, removed 5 s later with a 1 s threshold. |
| R7 | The fixture completes to the committed `.idx` on Node, in a Durable Object and in Chromium; `make-fixture.ts` checks that `.idx` against git's index of the completed pack. |

### Mutation check

Each mutation applied alone to `src/index-pack.ts`, the matching tests run (`-t`), file restored.

| Mutation | Caught by |
|---|---|
| M1 base from the repository not verified against its id | R1b hash case |
| M2 header count not rewritten after appending | R1 (4: verify-pack / idx) |
| M3 received part not re-hashed while it is copied | R1b "stored pack changing" (added after the first run missed it) |
| M4 unresolved deltas walked backwards | R1 (4: appended order differs from git's) |
| M5 entry count not checked against the pack size | R4 (allocation fails with a RangeError, not PackError) |
| M6 no window: one storage read per load | R5 |
| M7 window lower bound not checked (stale window served) | R1, R2 (6) |
| M8 a REF child's base index not recorded | R1b "evicted base reached through REF links" (added after the first run missed it) |
| M9 sweep ignores the age | R6 (2) |
| M10 sweep removes any file | R6 |
| M11 appended entry's CRC without its header | R1 (4: idx differs from git's for our pack) |
| M12 REF children never found | R1, R1b, R2 (13) |

### X6a against X6b1 (`scripts/compare.ts`, Node 22, same packs, on local disk)

| Pack | X6a time | X6b1 time | X6a peak | X6b1 peak |
|---|---|---|---|---|
| 200 000 objects (half deltas) | 45.8 s | 5.8 s | +134.7 MiB | +23.9 MiB |
| 60-commit history (254 entry loads) | 159 ms | 46 ms | +3.9 MiB | +0.1 MiB |

Peaks sampled after a GC on every 64th chunk read (R3 samples on every read and reads +14.0 MiB:
the coarser sampling here also counts garbage between collections). X6a's time goes to one
storage read per delta load (100 000 opens of the file); X6b1 serves them from the window.

## Functional description

```ts
const odb = await openObjectDatabase(files, "/.git/objects");            // X6r
const r = await installPack(files, "/.git/objects/pack", stream, {
  externalBase: async (oid) => {                                         // git's --fix-thin
    const o = await odb.get(oid);
    return o && { type: o.type, data: await bytes(o.content) };
  },
  maxObjectSize: 2 ** 30, baseCacheBytes: 32 * 2 ** 20, windowBytes: 2 ** 20,
});
r.packId; r.count; r.idx; r.stats;   // { appended, storageReads, deltaLoads }
r.entries;                           // IndexedEntry[], materialised on first access
                                     // (the result keeps the entry table alive until dropped)
await sweepPackTemporaries(files, "/.git/objects/pack", { olderThanMs: 14 * 24 * 3600e3 });
```

## Interfaces produced

```ts
type ExternalBase = (oid: string) => Promise<{ type: ObjectTypeName; data: Uint8Array } | undefined>;
function installPack(files: FilesApi, packDir: string, source: AsyncIterable<Uint8Array>,
  opts?: { maxObjectSize?; baseCacheBytes?; maxPackSize?; externalBase?: ExternalBase; windowBytes? },
): Promise<{ packId; count; idx; readonly entries: IndexedEntry[]; stats }>;
function writeIdx(entries: IndexedEntry[], packId: string): Uint8Array;            // unchanged
function sweepPackTemporaries(files: FilesApi, packDir: string,
  opts: { olderThanMs: number; now?: number }): Promise<string[]>;
class PackError extends Error {}
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/index-pack.ts` | **Adopt** | supersedes X6a's: same results, thin packs, compact entries, windowed phase 2 (imports X1d's inflater and X6a's delta/CRC by path) |
| `src/fixture-base.ts`, `src/do-entry.ts`, `scripts/make-fixture.ts` | **Source** | fixture and DO harness |
| `scripts/compare.ts` | **Source** | X6a vs X6b1 measurements |

## Open threads (ranked by how much later work they would invalidate)

1. **X6b2**: resumable, time-sliced indexing across Durable Object requests (the typed tables make
   the state serialisable: a few arrays and the phase/position).
2. **X6b3**: exploding a pack into the native SQL store (X3b) in batched transactions.
3. `check_collision` against objects already present, and SHA-1 collision detection.
4. Byte-identical appended entries would need git's zlib settings; nothing needs them so far.
