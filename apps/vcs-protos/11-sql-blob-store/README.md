# 11 — Should git objects in SQL go through a native chunked BlobStore or through SqliteFilesApi?

Plan id **X3b** (second slice of X3 "SQLite / Durable Object storage stack"). Status: **answered — native wins: same correctness everywhere, one statement and one commit per small object instead of 29 statements (≈3× faster with either journal mode); composition stays a fallback.**

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

**Native.** `sqlBlobStore(db)` — a `blobs` row per blob (content up to one chunk inline), 1 MiB
`chunks` rows under an immutable integer handle beyond that, `putStaged` committing in one
transaction that checks every staged row survived — passes webrun-storage's BlobStore behaviour
and X4's git-object contract on node:sqlite, sqlite-wasm and a workerd Durable Object; never
exposes a partial blob (a Db failing at every statement of a staged put, and a sweep by another
process in the middle of a put, both leave no blob or the whole blob); streams 64 MB with a few MB
live; reads only the rows a range touches; and stores git-sized objects **about 3× faster than the
composition** over SqliteFilesApi (2 statements and one commit per object vs 29), with the default
rollback journal and with WAL alike.

Findings:

1. **Small objects must not stage.** Staging every object through a temporary row costs two
   commits per object (on a file database each commit is a disk sync). Content up to one chunk is
   buffered — as the pieces received, never a chunk-sized buffer — and committed inline in one
   transaction, JGit's small-object path. Pack ingest (X6) should still batch many objects per
   transaction: one sync per object remains.
2. **Never rename data.** The first version committed by renaming chunk rows from a temporary id
   (`UPDATE … SET id`), which rewrites every 1 MiB row because it changes the primary key (review:
   the rename of a 64 MB blob took longer than writing it). Chunks are now keyed by an integer handle
   from a `staging` table (`AUTOINCREMENT`: a plain `INTEGER PRIMARY KEY` reuses deleted rowids,
   and a new handle collided with a committed blob's rows — M11), and the commit only inserts the
   blob row.
3. **A sweep must never produce a broken blob.** The first version let a sweep by another process
   remove a slow put's rows, after which the put committed a blob whose chunks were missing — and
   "existing wins" kept it forever (review blocker). The commit now verifies, in its transaction,
   that the staging row and all rows with their total size are still there, and fails otherwise;
   a store never sweeps its own in-flight handles.
4. **One connection per database file per thread.** Two `Db`s on one file fail half their writes
   with "database is locked" (busy timeout 0; a timeout would deadlock a single thread since the
   lock holder cannot run). Failures are clean — no partial blobs (trap test). Multi-process Node
   needs WAL and a busy timeout; OPFS sahpool is exclusive anyway (X3a).
5. **Reads are one row per query, length-checked**, so memory stays at one chunk; a reader racing a
   `remove` of the same blob gets "chunk missing", never other bytes (handles are immutable).
   `remove` must not race readers (gc leases, X18).
6. **Durable Object limits by construction**: at most five bound values and one chunk (1 MiB, below
   the documented ~2 MB per value) per statement, no `BEGIN`, and a 16 MiB blob round-trips in a DO.
   Local workerd accepted 2.1 MB values (Cloudflare documents 2 MB): the DO run is not proof of the
   production limit.
7. **Empty content is NULL inline** (X3a's Node 22 empty-BLOB bug), tables are rowid tables (rows up
   to a chunk would bloat a WITHOUT ROWID b-tree), and `size`/`has` never read content.

## Verified

All 13 Node tests and 2 Chromium tests pass (`pnpm test 11-sql-blob-store`).

| # | Result |
|---|---|
| R1 | 24-case contract (webrun-storage's 15; empty blob; 3-row blob whole and at six row-boundary ranges; chunk−1 / chunk / chunk+1 / 2 chunks; putStaged commit, failure, existing-wins; own in-flight puts never swept; 10 concurrent staged puts of one id; lone-surrogate ids refused and `list` bounded for a U+10FFFF prefix) on node:sqlite memory and file, sqlite-wasm in Chromium and a DO. |
| R2 | X4's 20-case git-object contract on node:sqlite, Chromium and a DO. |
| R3 | Db failing before every statement of a 4-row staged put (simulated: the library's ROLLBACK runs; a real process kill relying on journal recovery is not exercised): only "absent", or "whole" for the completed run; nothing left to sweep; the same put then succeeds. A sweep by a second store instance during a paused put: a fresh handle is kept (age 1 h), age 0 removes it, the put then rejects, nothing is visible, a retry works. Failed puts (bad `idOf`, dying stream) leave nothing for a restarted process to sweep. Two connections, 40 concurrent puts: 20 fail with "database is locked", every successful one reads back exactly. |
| R4 | 64 MB incompressible, node:sqlite file, live heap + array buffers sampled inside the producer and consumer loops (a timer never fires under synchronous node:sqlite): write +4–6 MB, read +1 MB; RSS +5–7 MB during the write (SQLite's page cache and journal are outside the heap). |
| R5 | A range inside one row of a 10-row blob fetched 1 chunk row; across a boundary, 2. |
| R6 | node:sqlite file, X4's kernel, 2 000 objects of 100 B – 8 KiB: rollback journal + `synchronous=FULL` (defaults) — native put 3.5–4.0 s, composition 11.6–12.0 s; WAL + `synchronous=NORMAL` — 0.9–1.1 s vs 3.1–3.4 s. Native: 2 statements per put, 1 per get; composition: 29 and 2. 16 × 1 MiB: put 0.8–0.9 s both, get 0.1–0.17 s both. DO commit cost not measured. |

### Mutation check

All re-run against the final code and tests.

| Mutation | Caught by |
|---|---|
| M1 commit outside a transaction | contract (memory, file), crash test, DO |
| M2 existing blob not checked at commit | contract, object contract, DO (5 tests) |
| M3 a read fetching all remaining rows per step | R5 row count |
| M4 range reads start at row 0 | R5 row count |
| M5 `sweepStaged` ignores age | R3b (fresh handle kept) |
| M6 `putStaged` keeps staged rows when `idOf` fails | R3d (restarted process finds leftovers) |
| M7 off-by-one in range slicing | contract ranges (3 tests) |
| M8 a full row buffer overwritten instead of flushed | 8 tests |
| M9 commit without verifying the staged rows | R3b |
| M9a only the row-count part of that check removed | survives: the staging-row and byte-sum checks already catch a sweep (redundant by design) |
| M10 sweep ignores this store's in-flight puts | contract (3 tests) |
| M11 staging handles without `AUTOINCREMENT` | contract, R6 (4 tests) |
| M12 lone-surrogate ids accepted | contract (3 tests) |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| Plan X3: decide composition (a) vs native (b) by throughput | Native: as correct, ≈3× faster on git-sized objects (one row and one commit per object vs 29 statements), large blobs equal. |
| First version: "staging + rename is atomic and cheap" | Atomic, but the rename rewrites every row; immutable handles avoid it. |
| First version: "a staged put is never visible partially" | Not with a concurrent sweep; the commit must verify its rows (review blocker). |
| First version: "64 MB in +0.0 MB / +1.0 MB" | The sampler never ran mid-stream; in-loop sampling gives +4–6 MB / +1 MB. |
| First version: "2.5× faster" without durability settings | ≈3× with the default journal and with WAL + NORMAL, after removing the per-object 1 MiB buffer the first version allocated. |

## Functional description

```ts
const store = await sqlBlobStore(db, { prefix: "objects_", chunkSize: 2 ** 20 });
const objects = gitObjects(store);                 // X4 kernel: git ids, zlib loose bytes
await objects.put("blob", size, stream);           // ≤ 1 MiB: one INSERT in one transaction
```

`blobs(id, size, chunk_size, handle, inline)`, `chunks(handle, seq, data)` and
`staging(handle AUTOINCREMENT, created)`; listing is a primary-key range scan; `remove` deletes the
blob row and its chunks in one transaction; `sweepStaged(age)` removes staged handles older than
`age` that this store is not writing. The chunk size is recorded per blob, so it can change between
opens without migrating data.

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

1. **Batching**: a transaction scope for many puts, so pack ingest (X6) pays one sync per pack, not
   per object.
2. **Scheduling sweeps**: nothing calls `sweepStaged` yet (a DO alarm, or on open with an age of
   hours).
3. **Upstream**: this store belongs in webrun-storage (or statewalker-db) next to `putStaged`.
4. **Real crash recovery** (process kill with a hot journal) and DO commit costs are not measured.
5. **CellB / celld** runtimes (X0b).
