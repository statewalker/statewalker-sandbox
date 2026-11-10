# 10 — Can one atomic ref-transaction API run on git files, SQL and KV, with git's semantics?

Plan id **X5** ("Ref transactions"). Status: **answered — yes on all three; git files need JGit's two-phase packed-refs commit, KV needs one root value (762 KiB per 10 000 refs).**

## Question

X2 gave a single-ref compare-and-set on git's files backend and X3a one on SQL/KV. Pushes, fetches
and rebases update several refs at once (`git push --atomic`, `update-ref --stdin` transactions,
JGit's `BatchRefUpdate`), and a repository also has a symbolic `HEAD`, `packed-refs` and reflogs.
Can one `RefDb` API — `batch(commands)` with per-ref expected old values, all-or-nothing — be
implemented

- on **git's files layout** over FilesApi primitives, so that native git reads every result and
  both sides' locks exclude each other, and a crash at any step leaves every ref of the batch at
  its old value or every ref at its new value (JGit's `PackedBatchRefUpdate`: pack the involved
  loose refs while holding their locks, then commit the whole batch with one atomic rename of
  `packed-refs.lock`);
- on **SQL** (statewalker-db `Db`) as one transaction (`inTransaction`, which uses
  `storage.transaction` in a Durable Object); and
- on a **KvStore**, which has only single-key compare-and-set — by keeping all refs under one
  root key (snapshot + root CAS)?

## Reject condition

Rejected if any backend applies part of a batch, accepts a name `git check-ref-format` refuses or
refuses one it accepts, accepts a directory/file conflict git refuses, loses an update under
concurrent overlapping batches, or (files) leaves a mix of old and new values after a crash, or
writes refs, packed-refs or reflogs that native git misreads.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Ref names: a table of ≥ 50 names is accepted/refused exactly as `git check-ref-format` (with and without `--allow-onelevel`) decides; every backend refuses a batch containing a refused name. |
| R2 | Atomicity: a batch whose any command's expected old value mismatches (including "must not exist" for an existing ref) changes nothing and reports the mismatching refs; creates, updates and deletes in one batch apply together. Duplicate names, a create below an existing ref (`refs/x` → `refs/x/y`, even if the batch deletes `refs/x`) and parent+child in one batch are refused, as git refuses them. |
| R3 | Symbolic refs: `HEAD → refs/heads/main`; reading resolves; a batch command on `HEAD` updates its target and logs both; `setSymref` is a compare-and-set on the symref's target. |
| R4 | Reflog: each applied command appends `<old> <new> <ident> <time> <tz>\t<message>` to the ref's log. |
| R5 | Concurrency: 20 concurrent batches, each moving two refs from generation n to n+1 with expected old values and retrying on mismatch/locked, end with both refs at the same generation equal to the number of successful batches — on every backend. |
| R6 | Git files interop (Node): native git (`for-each-ref`, `show-ref`, `rev-parse`, `reflog`) reads our loose refs, `packed-refs` (with existing peel lines kept) and logs; we read refs git wrote loose and packed (`pack-refs --all`, peeled tags). Our locks make `git update-ref` fail and git's locks make our batch report `locked`. |
| R7 | Crash (files): a batch over several loose and packed refs, killed at every primitive call in turn, leaves either all old or all new values once stale locks are broken. |
| R7c | Readers (files, added after review): `list()` paused before or after reading packed-refs while a batch commits returns all old or all new values. |
| R8 | Runtimes: the R2–R5 contract passes in Chromium (files on OPFS, SQL on sqlite-wasm, KV in memory) and inside a Durable Object (SQL and KV over `sqlKvStore`). The KV snapshot size for 10 000 refs is recorded against the DO value limit. |

## Scope — what this prototype does NOT do

- No reftable format, no ref advertisement, no remote-tracking semantics (X8).
- No reflog expiry, no `HEAD@{n}` parsing.
- Object existence is not checked: refs point at ids (as `update-ref` with any valid id).

## Answer

**Yes.** One `RefDb` API — `batch(commands)` with per-ref expected old values, all-or-nothing,
symbolic refs dereferenced (or not, with `noDeref`), reflogs as git writes them — runs on git's
files layout, on SQL and on a KvStore. A 20-case contract passes on every backend in Node,
Chromium and a workerd Durable Object.

- **git files**: single-ref commands use X2's loose protocol (lock with the new value, compare,
  rename). Multi-ref batches use JGit's `PackedBatchRefUpdate` algorithm: lock every ref (sorted,
  retried for 100 ms like `core.filesRefLockTimeout`; HEAD too when a command goes through it),
  lock `packed-refs` (1000 ms like `core.packedRefsTimeout`), re-dereference and **re-check
  directory/file conflicts under the locks** (other writers' lock files count as pending names),
  compare, **pack the involved loose refs first** (commit packed-refs, *then* remove the loose
  files), re-take the lock, and **commit the whole batch with one rename of `packed-refs.lock`**.
  Killed at every primitive call — multi-ref batches over packed-only, loose-only and
  loose-over-stale-packed refs, single-ref updates and deletes, `setSymref` — every outcome is
  all old or all new. Readers: `list()` scans loose refs, reads packed-refs, re-scans and retries
  if the loose set moved, so it never mixes states. Native git reads what we write and we read
  what it writes; git run while our batch is paused in phase 2 is refused on both the ref lock
  and `packed-refs.lock`.
- **SQL**: a batch is one `inTransaction` from `@statewalker/db-sqlite` — BEGIN/COMMIT on
  node:sqlite and sqlite-wasm, `storage.transaction` in a Durable Object — with checks, writes and
  reflog rows inside it (the callback is idempotent, as a DO may re-run it). Listing and conflict
  checks are primary-key range scans.
- **KV**: all refs in one root value; a batch is one root compare-and-set, re-read and re-checked
  after a lost race (with backoff). 10 000 refs (32-character names) take 762 KiB: under the
  ~2 MB SQLite string/BLOB limit that applies through `sqlKvStore` in a Durable Object (~25 000
  refs), but far above the 128 KiB value limit of the DO `storage.put` KV API.

Findings:

1. **Crash atomicity costs a packed-refs rewrite per batch.** JGit's two phases make a multi-ref
   batch atomic across crashes, at the price of rewriting `packed-refs` (linear in all refs) and
   moving the involved refs from loose to packed. Git's own files backend renames each ref's lock
   in turn (`files_transaction_finish`), so a crash between renames leaves part of a transaction
   applied. Phase 1 must commit packed-refs before removing loose files (M2).
2. **A name outside `refs/` never goes into packed-refs.** The first version packed a detached
   HEAD and deleted the `HEAD` file, after which git no longer recognised the repository (review
   blocker). A detached HEAD now updates only alone; in a multi-ref batch it is refused as
   `not-atomic` on every backend (JGit likewise refuses symrefs in atomic batches).
3. **Reader atomicity needs git's read order and a re-scan.** Reading packed-refs before loose
   refs can return a value that was never committed; reading loose first without re-scanning can
   mix old and new refs. Loose → packed → loose-again with retry passes both paused-reader tests.
   Single-ref reads treat a loose file that vanishes mid-read as absent and fall back to packed.
4. **Directory/file conflicts must be checked under the locks** (two concurrent batches created
   both `refs/x` and `refs/x/y` before), and deleted refs must prune empty parent directories (as
   git's `try_remove_empty_parents`), or `refs/heads/a/b` → delete → `refs/heads/a` fails with
   EISDIR.
5. **git's batch rules, measured on git 2.43**: create below an existing ref refused even if the
   batch deletes it (JGit allows that case; we follow git), a ref and its child refused in one
   batch, HEAD and its target refused together, delete with old = "must not exist" refused, delete
   of an absent ref allowed, empty batch a no-op.
6. **Reflogs as git**: appended with O_APPEND under the ref lock (no private log lock that a crash
   could leave behind), HEAD logged also when its branch is updated directly, whitespace collapsed,
   no tab without a message, no-op updates not logged, log removed on delete. A reflog failure
   after the commit never fails the batch (JGit's choice). KV reflogs are best effort and not
   ordered with concurrent batches.
7. **packed-refs header** `# pack-refs with: sorted`, peel lines of untouched refs kept; git peels
   the rest on demand. Loose refs are parsed as git does (`ref:` with optional spaces, an id
   followed by anything); broken loose refs are skipped by `list`, as `for-each-ref` skips them.
8. **OPFS readers race with writers**: `NotFoundError` = absent, `NotReadableError` = read again.

## Verified

All 21 Node tests and 3 Chromium tests pass (`pnpm test 10-ref-transactions`).

| # | Result |
|---|---|
| R1 | 54 names decided exactly as `git check-ref-format` (with and without `--allow-onelevel`); the review also fuzzed 3 013 random names with no rule difference. |
| R2 | On every backend: one mismatch rejects the batch; create + update + delete apply together; invalid names, duplicates (also HEAD + its target), parent + child, create below an existing ref (alone and in a batch, and when the batch deletes it), create above existing refs, delete with old = must-not-exist are refused; delete of an absent ref and the empty batch succeed; a deleted ref's name can become a directory and back. |
| R3 | `HEAD → refs/heads/main` resolves; a batch on HEAD updates main and logs both (old/new checked); `noDeref` detaches HEAD; a detached HEAD in a multi-ref batch is refused as `not-atomic`; `setSymref` is a compare-and-set on the target. |
| R4 | Reflog lines: old, new, ident, message; HEAD logged for direct branch updates; no-op updates not logged; delete drops the log. Files: git's exact line format (collapsed whitespace, no tab without message) read by `git reflog`; a stale `logs/*.lock` does not disable logging; a log write failure after the commit still reports ok. |
| R5 | 20 concurrent two-ref batches with retry end at 20 on every backend, while a concurrent `list()` never shows the two refs apart; 10 rounds of concurrent `refs/rN` / `refs/rN/y` creates never both succeed. (On SQL, statewalker-db's per-connection queue serialises the batches; two connections would meet SQLITE_BUSY instead.) |
| R6 | Native git reads our loose refs, packed-refs (peel line kept), symbolic HEAD and reflogs, `git fsck` passes; we read git's loose, packed and peeled refs and lenient loose formats. With our batch paused inside phase 2, `git update-ref` fails on `refs/heads/main.lock` and `git update-ref -d` on `packed-refs.lock`; with git's lock held, our batch reports `locked`. |
| R7 | Crash at every primitive call: a multi-ref batch over a packed ref, a loose-over-stale-packed ref, a loose-only ref and a new ref; a single-ref update, a single-ref delete of a loose+packed ref, and `setSymref` — every outcome all old or all new. |
| R7c | `list()` paused before and after reading packed-refs while a batch moves a loose and a packed ref: all old or all new. |
| R8 | The contract passes in Chromium (files on OPFS — three runs, SQL on sqlite-wasm, KV in memory) and inside a SQLite-backed Durable Object (SQL; KV over `sqlKvStore`). KV root for 10 000 refs: 762 KiB. |

### Mutation check

All re-run against the final tests (the review showed that the first contract let "create below
an existing ref" go untested).

| Mutation | Caught by |
|---|---|
| M1 files: no phase 1 | R6 (2), R7, reflog-failure test |
| M2 files: loose files removed before the phase-1 commit | R7 |
| M5 KV: `put` instead of root compare-and-set | KV contract (3) |
| M6 parent + child in one batch allowed | contract, every backend (7) |
| M7 / M7a creates below or above existing refs allowed / only "below" removed | contract, every backend (7 / 6) |
| M8 names ending in `.lock` accepted | R1 (2), contract |
| M10 files: multi-ref locks never released | contract, R6, R7, R7b, paused-git test |
| M11 SQL: reflog kept on delete | SQL contract, DO |
| M12 files `list`: no loose re-scan | R7c (before) |
| M13 files `list`: packed-refs read before loose refs | R7c (after) |
| M14 files: no directory/file re-check under the locks | concurrent create case (2) |
| M15 files: no directory pruning | name-reuse case on Node fs |
| M16 detached HEAD allowed in multi-ref batches | contract, every backend (7) |
| M17 HEAD not logged for direct branch updates | contract, every backend (7) |
| M18 files: no-op updates logged | contract on files (2) |
| M19 files: reflog errors fail the batch | reflog-failure test |
| M20 delete with old = must-not-exist accepted | contract, every backend (7) |

Not covered by a test: a `setSymref` racing between dereference and commit (the batch re-checks
targets under its locks, but no test drives that race).

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| Plan: "git-files `.lock` + packed-refs" gives atomic transactions | Only with JGit's two-phase packed-refs commit; git's own files backend is not crash-atomic across refs. |
| First version: "readers see all or nothing" | Only after fixing the read order (loose → packed → loose again); the review found `list()` could return a never-committed value. |
| First version: HEAD can join any batch | A detached HEAD in a multi-ref batch was packed and its file deleted, breaking the repository for git. |
| First version: conflict checks once, before locking | They must run again under the locks; concurrent batches created `refs/x` and `refs/x/y`. |
| Plan: "KV snapshot+root-cas vs per-key journal" — open | Root CAS works everywhere and is simplest; bounded by one value; SQL is the DO choice. |
| OPFS file reads are safe while other workers write | Reads must treat `NotFoundError` as absent and retry `NotReadableError`. |

## Functional description

```ts
const refs = filesRefDb(nodeRefFiles(".git"));          // or sqlRefDb(db) / kvRefDb(kv)
await refs.batch(
  [
    { name: "refs/heads/main", old: a, new: b },        // must currently be a
    { name: "refs/tags/v2", old: null, new: c },         // must not exist
    { name: "refs/heads/tmp", new: null },               // delete, unchecked
  ],
  { ident: "A U Thor <a@example.com> 1700000000 +0000", message: "push" },
); // → { ok: true, rejected: [] } or { ok: false, rejected: [{ name, reason }] }
```

Shared rules (`checkNames`, `checkAtomic`, `checkBatch`, `addHeadLogs`, `normalizeMessage`) give
every backend git's semantics; each backend dereferences, compares and commits in its own atomic
unit — one packed-refs rename, one SQL transaction, or one root compare-and-set.

Known differences from git, accepted for the prototype: one-level pseudorefs (`ORIG_HEAD`,
`FETCH_HEAD`) are not updatable; reflogs are written for every ref (git: `core.logAllRefUpdates`,
not tags or bare repositories); `setSymref` writes no reflog; no `verify` command; case-insensitive
file systems are not handled (JGit has special code); no fsync (a torn packed-refs would lose all
packed refs — git does not fsync refs by default either); the OPFS `remove` of X2 is recursive.

## Interfaces produced

```ts
interface RefDb {
  read(name): Promise<{ oid } | { symref } | undefined>;
  resolve(name): Promise<string | undefined>;
  list(prefix?): AsyncIterable<{ name; oid }>;                 // refs/ only, byte order
  batch(commands: { name; old?; new; noDeref? }[], opts?: { ident?; message? }): Promise<BatchResult>;
  setSymref(name, target, expected?: string | null): Promise<boolean>;
  reflog(name): Promise<ReflogEntry[]>;
}
type RejectReason = "mismatch" | "locked" | "invalid-name" | "df-conflict" | "duplicate"
                  | "invalid-command" | "not-atomic";
function filesRefDb(files: RefFiles, opts?: { refLockTimeoutMs?; packedLockTimeoutMs? }): RefDb;
function sqlRefDb(db: Db, prefix?: string): Promise<RefDb>;
function kvRefDb(kv: KvStore, root?: string): RefDb;
interface RefFiles extends AtomicFiles {                         // X2 + four methods
  write(path, bytes); list(dir); append(path, bytes); removeEmptyDir(dir);
}
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/refname.ts`, `src/batch-rules.ts` | **Adopt** | git's name and batch rules, checked against git |
| `src/files-ref-db.ts` | **Adopt** | git-compatible ref database for FilesApi backends (Node, OPFS) |
| `src/sql-ref-db.ts` | **Adopt** | the ref database for SQL and Durable Objects |
| `src/kv-ref-db.ts` | **Source** | root-CAS ref database for plain KvStores; bounded by one value |
| `src/ref-contract.ts`, `src/refname-table.ts` | **Adopt** | conformance for every ref backend |
| `src/adapters/*` | **Source** | RefFiles over Node, OPFS (with the race handling) and memory |

## Open threads (ranked by how much later work they would invalidate)

1. **FilesApi primitives upstream**: `createExclusive`, `replace` (X2) plus write-own-file,
   append, recursive file `list` and `removeEmptyDir` — the set a git-compatible repository on
   FilesApi needs.
2. **Ref listing at scale on files**: `list` reads every loose file twice plus packed-refs; large
   repositories need packed-refs binary search and lazy loose scanning.
3. **Multi-tab OPFS** with refs (X2 covered 4 workers on single refs).
4. **Reflog atomicity** on files/KV, reflog expiry, `core.logAllRefUpdates`.
5. **Reftable** if crash-atomic transactions without packed-refs rewrites are needed at scale.
