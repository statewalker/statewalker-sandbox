# 08 — Can a KvStore whose compare-and-set is one SQL statement be linearizable on node:sqlite, sqlite-wasm and a Durable Object?

Plan id **X3a** (first slice of X3 "SQLite / Durable Object storage stack"). Status: **answered — yes on all three; a multi-process busy timeout and a single owner per OPFS sahpool pool are requirements, not options.**

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

## Answer

**Yes.** A `KvStore` whose every write is one SQL statement — `cas` reading its outcome from
`RETURNING` — passes webrun-storage's contract and is linearizable on `node:sqlite` (one connection,
two connections, four processes), on sqlite-wasm with an OPFS database in a Chromium worker, in a
SQLite-backed **Durable Object on workerd**, and on statewalker-db's strict Durable Object fake. No
transaction and no `PRAGMA` are needed, which is what makes it run unchanged inside a Durable Object.

Two findings change the design around it:

1. **Several processes on one file need a busy timeout.** statewalker-db's Node driver opens
   `DatabaseSync` without one, so contended writers fail immediately with `database is locked`
   (observed: `0:busy 1:busy 2:busy 3:ok`). The failure is explicit, never a wrong `ok`, but writers
   fail instead of waiting. With `PRAGMA busy_timeout = 5000`: `1:ok`, the other three a clean
   `mismatch`. Durable Objects forbid `PRAGMA` and need none (one isolate per object).
2. **An OPFS `opfs-sahpool` pool belongs to one worker — not just one database.** Installing the VFS
   takes an exclusive sync access handle on every file of the pool, so while one worker has it, a
   second worker cannot open *any* database in it, even a different file: `NoModificationAllowedError:
   … Access Handles cannot be created if there is another open Access Handle`. Multi-tab use of a SQLite repository therefore needs one owning worker that
   other tabs talk to (SharedWorker, or leader election with Web Locks) — the multi-tab design for
   the SQL backend.

## Verified

All 13 Node tests and 3 Chromium tests pass (`pnpm test 08-sqlite-kv-cas`).

| # | Result |
|---|---|
| R1 | The KvStore contract (12 cases: roundtrip, binary values 0x00–0xff and zeros, empty values, cas match/stale/create/delete, two stale cas → one winner, `list(prefix)` in key order, `%`/`_` taken literally, prefixes followed by U+FFFD / U+1F600, a prefix ending at U+D7FF) on `node:sqlite` in memory and on a file, in the Chromium worker and in the Durable Object. On the strict DO fake all pass on Node 24; on Node 22 "empty values" fails (see Corrections). R1b: keys with NUL or a lone surrogate are refused by `get`/`put`/`cas`/`list` |
| R2 | 100 concurrent `cas` on one `Db`: one winner, final value is the winner's (Node and Chromium worker) |
| R3 | Two connections on one file see each other's writes (both run on one thread, so this is visibility, not contention). Four processes, start times checked to overlap (a child that starts late fails the test): without a busy timeout, at most one `ok` and at least one explicit `busy`; with `busy_timeout = 5000`, exactly one `ok` and three `mismatch` |
| R4 | Chromium Dedicated Worker, sqlite-wasm, OPFS database: contract and the 100-way race hold; trap test: while one worker owns the sahpool pool, a second worker cannot open even a *different* database in it (`NoModificationAllowedError`) |
| R5 | Durable Object on workerd (Miniflare 4, SQLite-backed class, `newDoSqliteDb(ctx.storage)`): contract holds; 100 concurrent requests, one `cas` each: exactly one winner — guaranteed mainly by DO request serialisation (input gates): a read-then-write `cas` with no timer between read and write would pass too, so here the test guards regressions rather than proving the statement; M5, which yields to a timer, does break it |
| R6 | 1 MiB values round-trip on Node and in the Durable Object; a 3 MiB value is refused (`SQLITE_TOOBIG` in workerd; an error and nothing stored on the strict fake) |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 update without `AND value = ?` | R1, R2, R3, R5 (8 tests) |
| M2 create as upsert (`DO UPDATE` instead of `DO NOTHING`) | R1 create/race cases (4 tests) |
| M3 `cas` outcome ignored (always true) | 8 tests |
| M4 `list` with `LIKE prefix || '%'` | the literal-prefix contract case (4 tests) |
| M5 read-then-write `cas` (SELECT, yield, UPDATE) | R1 concurrent case, R2, R3, R5 — 8 tests |
| M6 prefix successor not skipping the surrogate range | the U+D7FF contract case on node:sqlite and the fake (3 tests); workerd passes by accident (lone surrogates sort between U+D7FF and U+E000 there) |
| M7 `get` without key validation | R1b |
| M8 `list` upper bound inclusive (`<=`) | the high-code-point contract cases (4 tests) |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| Plan: "a strict DO-limits fake must be written for tests" | statewalker-db already ships one (`@statewalker/db-sqlite-do/fake`: `newFakeDoStorage()`); it is used here. |
| Plan: "`sqlKvStore` CAS = one statement; two-tab race" in the browser | Two tabs cannot both open an OPFS sahpool *pool* at all; the race happens inside the owning worker, and other tabs need a channel to it. |
| The contract here = webrun-storage's | It is stricter: list order, literal `%`/`_`, high code points and empty values are not checked upstream. |
| statewalker-db's DO fake mirrors workerd | On Node 22 it cannot store empty BLOBs, which real workerd stores: the fake binds `new Uint8Array(arrayBuffer)`, and Node 22's node:sqlite binds a view of a zero-length ArrayBuffer as NULL (`new Uint8Array(0)` binds as a BLOB; Node 24 fixes both). The test probes the runtime. |

## Functional description

`sqlKvStore(db, table)` creates `table(key TEXT PRIMARY KEY, value BLOB CHECK (typeof(value) =
'blob')) WITHOUT ROWID` and implements `get`, `put` (upsert), `remove` and `list` (a primary-key range
scan `key >= prefix AND key < successor(prefix)`, ordered by the BINARY collation, i.e. code-point
order). Keys with NUL or lone surrogates are rejected, since SQLite TEXT cannot store them faithfully — and `cas` as the single conditional statements above.
BLOBs come back as `Uint8Array` from every driver (the Durable Object driver converts
`ArrayBuffer`). The same contract module (`src/kv-contract.ts`) runs in Node, in the worker and
inside the Durable Object.

## Interfaces produced

```ts
function sqlKvStore(db: Db, table?: string): Promise<KvStore>; // KvStore from @statewalker/webrun-storage
function validateKey(key: string): string; // throws on NUL / lone surrogates
function prefixSuccessor(prefix: string): string | undefined; // code-point successor, skips surrogates
function runKvContract(make: () => Promise<KvStore>): Promise<{ cases: number; failed: string[] }>;
// workerd: class KvDo (SQLite-backed Durable Object), POST /contract, POST /cas, GET /get, POST /put-size
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/sql-kv-store.ts` | **Adopt** | The `KvStore` over SQL that webrun-storage lacks (gap G1); belongs in webrun-sync or statewalker-db |
| `src/kv-contract.ts`, tests | **Adopt** | KvStore conformance runnable in Node, workers and Durable Objects |
| `src/do-entry.ts` | **Source** | Pattern for running suites inside a Durable Object |

## Open threads (ranked by how much later work they would invalidate)

1. **Single OPFS owner**: design and prove the multi-tab channel (SharedWorker vs Web-Locks leader election) before the SQL backend is browser-ready.
2. **Busy timeout in statewalker-db's Node driver**: set a default (or expose an option); otherwise multi-process writers fail instead of waiting.
3. **`list` loads all matching rows**; page with `key > ?` (the range scan already uses the key) for large prefixes.
4. **CellB and celld** runtimes (DO semantics beyond workerd) not yet run; this used workerd itself.
5. Ref transactions across several keys (X5) — one statement per key is not enough for atomic multi-ref updates; Durable Objects offer `transactionSync`/`inTransaction`.
