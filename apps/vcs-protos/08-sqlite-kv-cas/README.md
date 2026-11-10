# 08 — Can a KvStore whose compare-and-set is one SQL statement be linearizable on node:sqlite, sqlite-wasm and a Durable Object?

Plan id **X3a** (first slice of X3 "SQLite / Durable Object storage stack"). Status: **in progress**.

## Question

The SQL and KV backends need refs with an atomic compare-and-set, and webrun-sync's `KvStore`
contract (`get`/`put`/`cas`/`remove`/`list`) exists only in memory today (gap G1; X3 found no KV over
SQL). statewalker-db's `Db` is deliberately small — `query`/`exec`, no change counts, no
`lastInsertRowId` — and Durable Objects forbid `BEGIN`/`PRAGMA`. Can `cas` be **one conditional
statement** whose `RETURNING` row says whether it won (`INSERT … ON CONFLICT DO NOTHING RETURNING`,
`UPDATE … WHERE key = ? AND value = ? RETURNING`, `DELETE … WHERE … RETURNING`), and is the result
linearizable on `node:sqlite` (one connection, several connections, several processes), on
sqlite-wasm in a Chromium worker (OPFS "sahpool", the engine cellb.dev uses), and in a Durable
Object on workerd (`ctx.storage.sql` through `newDoSqliteDb`)?

## Reject condition

Rejected if, on any runtime, two compare-and-sets from the same expected value both succeed, a
contended statement returns a wrong result instead of an explicit error, or `cas` cannot be
expressed without a transaction or `PRAGMA`.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | The `KvStore` contract of webrun-storage (roundtrip, cas match / stale / create / delete, two stale cas → one winner, `list(prefix)` in key order) holds on `node:sqlite`, with binary values (zero bytes, 0x00–0xff) round-tripping exactly. |
| R2 | 100 concurrent `cas` from the same expected value on one `Db`: exactly one `true`, final value is the winner's. |
| R3 | Two `Db` connections on one database file, interleaved: exactly one winner. Four Node processes on one file: exactly one winner; a contended statement either loses (`false`) or fails with an explicit busy error — never a wrong `true`. The effect of a busy timeout is recorded. |
| R4 | In a Chromium Dedicated Worker on sqlite-wasm with an OPFS (`opfs-sahpool`) database: R1 and R2 hold. What happens when a second worker opens the same database is recorded as a passing test (it decides the multi-tab design). |
| R5 | In a Durable Object on workerd (Miniflare, SQLite-backed class, `newDoSqliteDb(ctx.storage)`): R1 holds, and 100 concurrent requests each doing one `cas` produce exactly one winner. |
| R6 | Values up to 1 MiB round-trip in every runtime; behaviour for a value above the Durable Object row limit (~2 MB) is recorded. |

## Scope — what this prototype does NOT do

- No BlobStore / chunked objects (X3b), no git objects, no ref transactions across keys (X5).
- No CellB or celld (later X3 slice; this uses workerd itself via Miniflare).
- No change to statewalker-db: the store is built on its published `Db` API.
