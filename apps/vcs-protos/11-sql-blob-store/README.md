# 11 — Should git objects in SQL go through a native chunked BlobStore or through SqliteFilesApi?

Plan id **X3b** (second slice of X3 "SQLite / Durable Object storage stack"). Status: **in progress.**

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
