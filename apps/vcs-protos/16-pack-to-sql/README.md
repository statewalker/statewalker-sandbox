# 16 — Should the native SQL store explode received packs into object rows, or keep them as packs?

Plan id **X6** (pack ingest/export), slice **X6b3: packs into the native SQL store**. Status: **answered — keep the pack as the store of record; exploding works (git-identical, crash-safe, resumable in a DO) and reads 2.4–6.5× faster for 3× the bytes and ~4× the ingest: an optional read-optimised mode, not the default.**

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
batch })` writes the objects of an installed pack (read by X6r) into X3b's tables in X4's loose
format, many per transaction with the progress row in the same transaction; X4's
`gitObjects(sqlBlobStore(db))` reads them back. Every object of X6a's four native-git packs equals
`git cat-file` and verifies; a Db failing at any statement, then resumed, ends with every object
whole; a Durable Object restarted between steps explodes X6a's fixture pack completely.

Measured on node:sqlite, one file database each (1 050 objects, 13.8 MB of content, a 330 KB pack):

| | ingest | database | read every object | 1 000 random reads |
|---|---|---|---|---|
| pack + idx in SqliteFilesApi (X6b1 + X6r) | 207 ms (install) | 384 KB | 890 ms | 265 ms |
| exploded rows (X3b + X4) | + 620 ms (explode, after the install) | 1 237 KB | 136 ms | 109 ms |

- **Bytes**: exploded objects are zlib'd whole, without git's deltas: 3.2× the pack here (text
  history with many similar versions; incompressible blobs would differ less). The pack is what
  git serves and fetches, so keeping it costs nothing extra at push/fetch time (X6c).
- **Reads**: the pack's delta chains cost a patch per level (X6r's base cache helps sequential
  reads); exploded rows are one row and one inflate per object — 6.5× faster to read everything,
  2.4× on random reads.
- **Ingest**: exploding is a second pass after installing (read, re-deflate, insert): ~4× the
  install. Batching matters only up to tens of objects per transaction: 1 per transaction took
  1 127 ms, 64 took 210 ms, 1 024 took 223 ms — beyond that the cost is reading and deflating.
- **Decision**: the native SQL store keeps received packs (+ idx) as its store of record, as git
  does; exploding is an optional, resumable read-optimised mode for hot repositories (or a
  materialised cache of recent objects). A delta-aware row layout (Fossil's) would close the
  bytes gap; it is a later slice if storage becomes the constraint.
- **Crash safety**: small objects go inline in batches with the progress row in the same
  transaction; an object larger than one chunk goes through X3b's staged put (its own
  transaction) and the progress advances after it — a crash in between re-puts it, which X3b
  ignores (existing id wins). The progress never runs ahead of the objects.

## Verified

All 9 Node tests pass (`pnpm test 16-pack-to-sql`).

| # | Result |
|---|---|
| R1 | OFS, REF, `gc --aggressive`, a 4 MiB blob with a delta child: every object exploded reads back with git's type, size and content, verified; `list` yields exactly git's ids. |
| R2 | 87 KB pack (60 commits): 1 object per transaction 1 127 ms, 64: 210 ms, 1 024: 223 ms on a file database (5.05×: the criterion's 5× is met narrowly, because past ~64 objects reading and deflating dominate, not commits). |
| R3 | The 4 MiB-blob pack (small objects and one staged object) exploded in steps of 5 objects, batches of 4, with a Db failing at each of its statements in turn, then resumed: every object present and verified each time. The progress row never names an object that is not stored (steps of 37). |
| R4 | The table above. |
| R5 | X6a's fixture pack installed (X6b1) and exploded in a Durable Object in steps of 40 objects, the runtime restarted for every request: every object verifies. |

### Mutation check

| Mutation | Caught by |
|---|---|
| E1 progress set one past the batch | R1, R3 |
| E2 large object: progress written before its put | R3 (a crash between them loses the object) |
| E3 batching ignored | R2 |

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
3. Exploding in pack order rather than idx order would let X6r's base cache serve each chain
   once (idx order still read 1 050 objects in 620 ms including deflate).
