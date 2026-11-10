# 16 — Should the native SQL store explode received packs into object rows, or keep them as packs?

Plan id **X6** (pack ingest/export), slice **X6b3: packs into the native SQL store**. Status: **answered — keep the pack as the store of record; exploding works (git-identical, crash-safe, resumable in a DO) and reads text 3–7× faster, but costs 3× (text) to 34× (versioned binaries) the bytes and 5–10× the ingest: an optional read-optimised mode, not the default.**

## Question

X6b1/X6b2 install a received pack as git does — `pack-*.pack` + `.idx` — and on a SQL backend
those are two files in SqliteFilesApi, read through X6r's pack reader (delta chains, base cache).
X3b built a native SQL BlobStore that X4's object kernel uses for loose objects. For the native,
Fossil-like SQL store, should a received pack be **exploded** — every object written as a row
(X4's loose format in X3b's tables), many per transaction, resumably — or **kept** as a pack?
What do the two cost in ingest time, storage and read time, and can exploding run in a Durable
Object in bounded, crash-safe steps?

## Reject condition

Exploding is rejected if an exploded object differs from git's, if a crash can leave a partial or
missing object while the progress says it was written, or if it cannot run in bounded steps in a
Durable Object. The comparison is decided by the measurements, recorded either way.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Every object of X6a's four native-git packs, exploded into X3b's tables, reads back through X4's `gitObjects(sqlBlobStore(db))` with type, size and content equal to `git cat-file`, and verifies (`verify: true`). |
| R2 | Objects are written many per transaction: on a file database, exploding with 1 024 objects per transaction is at least 5× faster than one per transaction. |
| R3 | Exploding runs in steps of N objects, the progress committed in the same transaction as the objects; a Db that fails at statement k (k swept over a job), then a resume on a healthy Db, ends with every object present, correct and verified, and none partial. |
| R4 | For a pack of thousands of objects on node:sqlite (a file database): ingest time, database bytes and the time to read every object (and 1 000 random ones) are measured for exploded rows versus the pack + idx kept in SqliteFilesApi read by X6r; the decision is recorded. |
| R5 | In a Durable Object (Miniflare, persistent storage) X6a's fixture pack is exploded in steps with the runtime restarted between steps; every object verifies afterwards. |

## Scope — what this slice does NOT do

- Deltas in SQL (storing objects as deltas against each other): Fossil does; a later slice if R4
  shows storage matters.
- Garbage collection, repacking (X18), pack export (X6c).

## Answer

**Exploding works; keeping the pack wins as the default.** `explodeStep(db, reader, { units,
batch, batchBytes })` writes the objects of an installed pack (read by X6r, verified) into X3b's
tables in X4's loose format, many per transaction with the progress row in the same transaction;
X4's `gitObjects(sqlBlobStore(db))` reads them back. Every object of X6a's four native-git packs
equals `git cat-file` and verifies; a Db failing at any statement, then resumed, ends with every
object whole; a Durable Object restarted between steps — one step dying mid-batch, many objects on
X3b's staged path — explodes X6a's fixture pack completely.

Measured on node:sqlite, a file database each, two runs (ranges); the explode reads the installed
pack from SqliteFilesApi, as after a real ingest; "cold" random reads use a fresh pack reader,
"warm" ones follow a read of every object (X6r's 16 MiB base cache full):

| data | store | ingest | database | read all | 1 000 random |
|---|---|---|---|---|---|
| text history: 1 050 objects, 13.8 MB, pack 331 KB | pack + idx | 224–312 ms (install) | 393 KB | 802–846 ms | 457–646 ms cold, 241–250 ms warm |
| | exploded rows | + 1 473–1 687 ms | 1 233 KB (3.1×) | 118–145 ms | 116–136 ms |
| versioned binary: 40 × 256 KiB, 1-byte edits (120 objects, 10.5 MB, pack 272 KB) | pack + idx | 94–104 ms | 307 KB | 98–115 ms | 408–463 ms |
| | exploded rows | + 847–989 ms | 10 568 KB (34×) | 93–101 ms | 492–774 ms |

- **Bytes**: exploded objects are zlib'd whole, without git's deltas. Repetitive text: 3.1× the
  pack; versioned binaries (each version a near copy): **34×**. (The first version of this README
  said incompressible blobs "would differ less" — true only for unique blobs, false for versions:
  the review.)
- **Reads**: on text, rows read everything 6× faster and random objects 3.4–5.6× faster than a
  cold pack reader (1.8–2× than a warm one: the first version measured only warm, "2.4×"). On
  versioned binaries the pack is as fast or faster: few, large objects; a delta is cheap next to
  inflating 256 KiB.
- **Ingest**: exploding is a second pass after installing (read, verify, re-deflate, insert):
  5–10× the install (the first version read the pack from memory and said "~4×").
- **Decision**: the native SQL store keeps received packs (+ idx) as its store of record, as git
  does — compact on every kind of data, and what git fetches and pushes (X6c). Exploding remains an
  optional, resumable read-optimised mode for text-heavy hot repositories (or a cache of recent
  objects). A delta-aware row layout (Fossil's) would close the bytes gap: a later slice only if
  read time on packs becomes the constraint.
- **Batching**: one object per transaction against a handful is the difference (median of three:
  964–1 131 ms vs 238–269 ms), but past ~64 objects a transaction reading and deflating dominate,
  not commits: the criterion's 5× is **not met as written** (4.75–5.05× in the dev container; the
  review saw 3.9× without a warm-up; the CI runner, where commits are nearly free, no gain at
  all). The test asserts the transaction counts only.
- **Bounded steps**: a batch is committed at `batch` objects or `batchBytes` (8 MiB) of compressed
  data, whichever comes first (the review found up to 1 GiB per batch: 120 incompressible ~1 MB
  objects now add +8.7 MiB, +114.6 MiB before); a large object is streamed once into X3b's staged
  put (it was resolved twice), and skipped when already stored; the pack's ids are built once per
  reader. One unit is still one object: a 64 MiB delta-resolved object is materialised by X6r.
- **Crash safety**: small objects go inline in batches with the progress row in the same
  transaction; an object larger than one chunk goes through X3b's staged put (its own
  transaction) and the progress advances after it — a crash in between finds it stored and skips
  it. The progress only moves forward (`max`), never ahead of the objects. Inline objects are read
  with `verify`: a pack changed at rest is refused instead of leaving wrong bytes under an id that
  "existing wins" would keep forever. `batch` and `units` below 1 are refused (`batch: 0` spun the
  isolate).

## Verified

All 15 Node tests pass (`pnpm test 16-pack-to-sql`). The first tests were written alongside the
implementation; the review's findings got red tests first (the byte-budget test was first red for
the wrong reason — X6a's `buildPack` cannot hold 120 MB — and was rebuilt before its red run).

| # | Result |
|---|---|
| R1 | OFS, REF, `gc --aggressive`, a 4 MiB blob with a delta child: every object exploded reads back with git's type, size and content, verified; `list` yields exactly git's ids. |
| R2 | **Not met as written**: one transaction per object vs ≤ 2 for the pack (asserted); median times 964–1 131 ms vs 238–269 ms in the dev container (4.75–5.05×), and **no gain on the CI runner** (605 ms vs 794 ms), where a commit costs almost nothing. Batching pays where commits sync (a disk, a DO's storage); its speedup is the storage's, not a constant. |
| R3 | The 4 MiB-blob pack (small objects and one staged object) exploded in steps of 5 objects, batches of 4, with a Db failing at each of its statements in turn: after each failure every object the progress covers is stored; resumed, every object present and verified. |
| R4 | The table above. |
| R5 | X6a's fixture pack installed (X6b1) and exploded in a Durable Object with 4 KiB chunks (objects on the staged path) in steps of 40, the runtime restarted for every request, one step dying mid-batch: every object verifies. |
| Review | `batch`/`units` < 1 refused; a byte-bounded batch (+8.7 MiB for 120 × 1 MB); an inline object changed at rest refused, not stored; every object resolved once; a second explode stages no chunk rows. |

### Mutation check

| Mutation | Caught by |
|---|---|
| E1 progress set one past the batch | R1, R3 |
| E2 large object: progress written before its put | R3 (a crash between them loses the object) |
| E3 batching ignored | R2 (transaction count) |

## Interfaces produced

```ts
function explodeStep(db: Db, reader: PackReader, opts?: { units?; batch?; prefix?; chunkSize? }):
  Promise<{ done: boolean; next: number; total: number; written: number }>;
function explodedObjects(db: Db, opts?: { prefix?; chunkSize? }): Promise<GitObjects>;   // X4 over X3b
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/explode.ts` | **Source** | an optional read-optimised mode; the default keeps packs |
| `src/do-entry.ts` | **Source** | DO harness |

## Open threads (ranked by how much later work they would invalidate)

1. **X16**: one `ObjectStore` over packs (X6r) and loose objects (X4 on FilesApi or X3b rows),
   with exploding as a policy, not a different store.
2. A delta-aware SQL layout (Fossil) if storage matters more than read time.
3. Exploding in pack order rather than idx order was not faster in the review's runs (879 vs
   714 ms, 976 vs 1 058 ms): X6r's base cache already serves idx order.
