# 11 — Should git objects in SQL go through a native chunked BlobStore or through SqliteFilesApi?

Plan id **X3b** (second slice of X3 "SQLite / Durable Object storage stack"). Status: **answered — native wins: same correctness everywhere, one statement + one commit per small object instead of 29 statements; composition stays a fallback.**

## Question

X4 stored git objects in SQL by composition: `filesStagingStore(new SqliteFilesApi(db))` — a file
system emulated in three tables, then a BlobStore over it, then the object kernel. X4 also showed
that BlobStore needs `putStaged` (bytes first, id after). Is a **native** `sqlBlobStore(db)` —
blobs and chunk rows on statewalker-db's `Db`, `putStaged` as one transaction that renames a
temporary id — correct on node:sqlite, sqlite-wasm and a Durable Object, bounded in memory, and
better than the composition for git's object mix (many small objects, some large)?

## Reject condition

Rejected if the native store fails webrun-storage's BlobStore behaviour or X4's object contract on
any runtime; if a staged put is ever visible partially (after a failure or a crash at any
statement) or two concurrent staged puts of one id leave anything but one blob; if a 64 MB blob
needs more than 16 MB of live memory to write or read; if a range read fetches rows outside the
range; or if it is not faster than the composition on small objects (then composition stays).

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | BlobStore contract: webrun-storage's 15 behaviours (ported from `webrun-storage/tests/blob-store.test.ts` into a portable function) plus empty blobs, multi-row blobs read whole and by ranges at row boundaries, `putStaged` (commit, failure, existing wins) and `sweepStaged` — on node:sqlite (memory and file), sqlite-wasm in Chromium and a Durable Object on workerd. |
| R2 | X4's 20-case git-object contract passes over the native store on the same runtimes. |
| R3 | Atomicity: a staged put whose stream fails, or whose Db dies at any statement, leaves either no blob or the complete blob, and `sweepStaged` removes what is left; 10 concurrent staged puts of one id leave one blob and no temporary rows. |
| R4 | Memory: a 64 MB incompressible blob is written and read back (streaming) with < 16 MB of live heap + array buffers on node:sqlite (file). |
| R5 | Range reads fetch only the chunk rows that overlap the range (counted at the Db). |
| R6 | Comparison on node:sqlite (file): 2 000 git-sized objects (100 B – 8 KiB) and 16 × 1 MiB objects written and read through X4's kernel, native vs composition: time and SQL statement count. |

## Scope — what this prototype does NOT do

- No packs (X6) and no deltas inside SQL.
- No full-text or path indexes (X9).
- No CellB/celld runtimes (X0b).

## Answer

**Native.** `sqlBlobStore(db)` — a `blobs` row per blob (content up to one chunk inline), `chunks`
rows of 1 MiB beyond that, `putStaged` committing in one transaction — passes webrun-storage's
BlobStore behaviour and X4's git-object contract on node:sqlite, sqlite-wasm and a workerd Durable
Object, never exposes a partial blob (a Db killed at every statement of a staged put leaves no blob
or the whole blob, and the store stays usable), streams 64 MB with about 1 MB live, reads only the
rows a range touches, and stores git-sized objects **2.5× faster than the composition** over
SqliteFilesApi (2 statements and one commit per object vs 29 statements).

Findings:

1. **Small objects must not stage.** The first version wrote every object to a temporary row and
   then committed — two commits per object; on a file database each commit is a disk sync, so
   2 000 small objects took 9.4 s. Buffering content up to one chunk and committing it inline in
   one transaction (JGit's small-object path in `ObjectDirectoryInserter`) halved that to 5.1 s.
   The remaining cost is one sync per object: pack ingest (X6) should batch many objects per
   transaction.
2. **Visibility is the blob row.** Chunk rows under a reserved `~tmp/<ms>/<random>` id are never
   visible; the commit renames them (`UPDATE … SET id`) and inserts the blob row in one
   transaction, or drops them when the id already exists. Without the transaction a crash between
   rename and insert leaves orphan rows under the final id that make a later put of the same blob
   fail (mutation M1, caught by retrying after every crash point).
3. **Reads are one row per query** so memory stays at one chunk whatever the blob size (reading all
   rows of a range in one query held 64 MB, M3).
4. **Durable Object limits are met by construction**: every statement binds at most five values
   and one chunk (1 MiB, below the ~2 MB SQLite value limit), no `BEGIN` (transactions go through
   `storage.transaction`), and a 16 MiB blob round-trips inside a DO.
5. **Empty content is stored as NULL** with an explicit `chunked` flag, sidestepping the Node 22
   empty-BLOB binding bug found in X3a.
6. **`verify` re-reads the staged copy** instead of buffering the blob (webrun-storage's
   `filesBlobStore`/`memBlobStore` buffer), so verified puts are bounded too.

## Verified

All 10 Node tests and 2 Chromium tests pass (`pnpm test 11-sql-blob-store`).

| # | Result |
|---|---|
| R1 | 22-case contract (webrun-storage's 15 plus empty blob, 3-row blob read whole and at six row-boundary ranges, putStaged commit / failure / existing-wins, sweepStaged keeping fresh and removing stale temporaries, 10 concurrent staged puts of one id) on node:sqlite memory and file, sqlite-wasm in Chromium and a DO. |
| R2 | X4's 20-case git-object contract over the native store on node:sqlite, Chromium and a DO. |
| R3 | Db killed at every statement of a 4-row staged put: outcomes "absent" and "whole" only, `sweepStaged` leaves nothing, and putting the same blob again succeeds; 10 concurrent staged puts → one stored, no temporary rows. |
| R4 | 64 MB incompressible, 1 MiB rows, node:sqlite file: live peak +0.0 MB writing, +1.0 MB reading (GC before each sample). A 16 MiB blob round-trips inside a DO. |
| R5 | A range inside one row of a 10-row blob fetched 1 chunk row; a range across a boundary, 2. |
| R6 | node:sqlite file, through X4's kernel: 2 000 objects of 100 B – 8 KiB — native put 5.1 s (2.0 statements/object), composition 12.8 s (29.0); get 0.19 s vs 0.30 s. 16 × 1 MiB — put 1.1 s vs 0.76–1.1 s, get 0.14–0.17 s vs 0.11–0.12 s over two runs (large blobs: no clear winner; the composition's 1 MiB block writes are as cheap as native rows). |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 commit outside a transaction | contract (memory, file, DO), crash test |
| M2 existing blob not checked at commit | contract, object contract, crash test, DO (6 tests) |
| M3 all rows of a read in one query | R4 read memory |
| M4 range reads start at row 0 | R5 row count |
| M5 `sweepStaged` ignores age | contract "keeps fresh temporaries" (3 tests) |
| M6 `putStaged` keeps temporary rows when `idOf` fails | contract leftover check (3 tests) |
| M7 off-by-one in range slicing | contract row-boundary ranges (3 tests) |
| M8 a full chunk buffer overwritten instead of spilled | 8 tests |

Two mutations (M5, M6) survived the first contract: it never swept with a non-zero age and its
failing-`idOf` case used 3 bytes, which take the inline path; both cases were strengthened.

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| Plan X3: decide "composition (a) vs native port (b)" by throughput | Native is as correct everywhere and 2.5× faster on git-sized objects because it needs one row and one commit per object; composition (SqliteFilesApi's paths/files/blocks tables) needs 29 statements. Large blobs cost about the same (run-to-run spread larger than the difference). |
| Staging every put through a temporary row is simple and cheap | It doubles commits; small content must commit inline. |

## Functional description

```ts
const store = await sqlBlobStore(db, { prefix: "objects_", chunkSize: 2 ** 20 });
const objects = gitObjects(store);                 // X4 kernel: git ids, zlib loose bytes
await objects.put("blob", size, stream);           // ≤ 1 MiB: one INSERT in one transaction
```

`blobs(id, size, chunk_size, chunked, inline)` and `chunks(id, seq, data)` (both `WITHOUT
ROWID`); listing and sweeping are primary-key range scans; `remove` deletes both in one
transaction. The chunk size is recorded per blob, so it can change without migrating data.

## Interfaces produced

```ts
function sqlBlobStore(db: Db, opts?: { prefix?: string; chunkSize?: number }): Promise<StagingBlobStore>;
function runBlobContract(make: () => Promise<StagingBlobStore>, chunkSize: number): Promise<{ cases; failed }>;
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/sql-blob-store.ts` | **Adopt** | The SQL/DO object store (and BlobStore for webrun-sync's content store) |
| `src/blob-contract.ts` | **Adopt** | Portable BlobStore conformance (upstream's suite is vitest-only) |
| `src/do-entry.ts` | **Source** | DO harness |

## Open threads (ranked by how much later work they would invalidate)

1. **Batching**: a `putMany`/transaction scope so pack ingest (X6) commits thousands of objects at
   once — the remaining small-object cost is one disk sync each.
2. **Upstream**: this store belongs in webrun-storage (or statewalker-db) next to `putStaged`.
3. **Compression inside rows** is the kernel's (zlib); a store-level codec is unnecessary for git
   objects but may matter for webrun-sync content.
4. **CellB / celld** runtimes (X0b).
