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
| R8 | Runtimes: the R2–R5 contract passes in Chromium (files on OPFS, SQL on sqlite-wasm, KV in memory) and inside a Durable Object (SQL and KV over `sqlKvStore`). The KV snapshot size for 10 000 refs is recorded against the DO value limit. |

## Scope — what this prototype does NOT do

- No reftable format, no ref advertisement, no remote-tracking semantics (X8).
- No reflog expiry, no `HEAD@{n}` parsing.
- Object existence is not checked: refs point at ids (as `update-ref` with any valid id).

## Answer

**Yes.** One `RefDb` API — `batch(commands)` with per-ref expected old values, all-or-nothing,
symbolic refs dereferenced, reflogs written — runs on git's files layout, on SQL and on a KvStore,
and a 12-case contract passes on every backend in Node, Chromium and a workerd Durable Object.

- **git files**: single-ref commands use X2's loose protocol (lock with the new value, compare,
  rename). Multi-ref batches use JGit's `PackedBatchRefUpdate` algorithm: lock every ref (sorted,
  retried for 100 ms like `core.filesRefLockTimeout`), lock `packed-refs` (1000 ms like
  `core.packedRefsTimeout`), compare, **pack the involved loose refs first** (their current
  values into packed-refs, then remove the loose files — readers see the same values), re-take
  the lock, and **commit the whole batch with one rename of `packed-refs.lock`**. Killed at every
  primitive call in turn, the batch left all old or all new values every time. Native git reads
  everything we write (`for-each-ref`, `rev-parse`, `symbolic-ref`, `reflog`, `fsck`), we read
  what it writes (loose, `pack-refs --all`, peeled tags), and each side's locks block the other.
- **SQL**: a batch is one `inTransaction` from `@statewalker/db-sqlite` — BEGIN/COMMIT on
  node:sqlite and sqlite-wasm, `storage.transaction` in a Durable Object — with reflog rows in the
  same transaction.
- **KV**: all refs in one root value; a batch is one root compare-and-set, re-read and re-checked
  on a lost race. 10 000 refs take 762 KiB, so a Durable Object value (2 MB) holds ~25 000 refs.

Findings:

1. **Crash atomicity costs a packed-refs rewrite per batch.** JGit's two phases make a
   multi-ref batch atomic for readers and across crashes, at the price of rewriting `packed-refs`
   (linear in all refs) and moving the involved refs from loose to packed. Git's own files backend
   commits a transaction by renaming each ref's lock in turn, so a crash between renames can leave
   part of it applied (reftable is git's answer). The order inside phase 1 matters: removing the
   loose files *before* the packed-refs commit exposes stale packed values (mutation M2, caught by
   the crash test once a ref has a different loose and packed value, as after `git pack-refs` and
   an update).
2. **git's batch rules, measured on git 2.43, not assumed**: a create below an existing ref is
   refused *even if the same batch deletes it* (`refs/x` → `refs/x/y`), a batch may not touch a ref
   and its child, and duplicates are refused. All backends apply these through one shared
   `checkBatch`.
3. **packed-refs header**: we write `# pack-refs with: sorted` and keep the `^peeled` lines of
   untouched refs; git peels the others on demand (`for-each-ref %(*objectname)` is right after our
   rewrite). Claiming `fully-peeled` would make git treat new annotated-tag refs as unpeelable.
4. **Reflogs follow git**: delete removes the log; an update through `HEAD` logs both `HEAD` and the
   target. Files and KV append after the commit (a crash in between loses log lines, never ref
   values); SQL writes them in the same transaction.
5. **OPFS readers race with writers.** A handle can disappear (`NotFoundError`) or its file be
   replaced (`NotReadableError`) between lookup and read when a lock is released, a loose ref is
   packed, or packed-refs is committed through `createWritable`. The adapter maps these to POSIX
   semantics — absent, or read again — which the 20-way concurrency case needs.
6. **The KV root is the scaling limit**: every batch rewrites the whole snapshot, and its size
   bounds the ref count per Durable Object value. A per-key layout with a journal would lift both;
   SQL is the better DO backend for refs anyway (one transaction, indexed listing, atomic reflog).

## Verified

All 14 Node tests and 3 Chromium tests pass (`pnpm test 10-ref-transactions`).

| # | Result |
|---|---|
| R1 | 54 names (dots, `.lock`, control characters, `@{`, `@`, `//`, trailing `/` or `.`, UTF-8, one-level) decided exactly as `git check-ref-format`, with and without `--allow-onelevel`; the contract checks that every backend refuses a batch with a refused name. |
| R2 | On every backend: a batch with one mismatching (or "must not exist" but existing) ref changes nothing and names it; create + update + delete apply together; duplicates, create below/above an existing ref (even if deleted in the batch) and parent + child are refused. |
| R3 | `HEAD → refs/heads/main` resolves; a batch on `HEAD` updates `refs/heads/main` and logs both; `setSymref` refuses a wrong expected target and "must not exist" on an existing ref. |
| R4 | Reflog lines carry old, new, ident and message (old = zero id on create); delete drops the log. |
| R5 | 20 concurrent batches, each moving two refs from n to n+1 in opposite lock orders with retry: both refs end at 20 on every backend (files on memory, Node fs and OPFS; SQL on node:sqlite, sqlite-wasm and DO; KV on memKvStore and X3a's sqlKvStore in Node and DO). |
| R6 | Native git reads our loose refs, packed-refs (peel line of an annotated tag kept), symbolic HEAD and reflogs; `git fsck` passes; we read git's loose, packed and peeled refs and rewrite them correctly (packed delete, loose update, packed update in one batch). git's lock makes our batch report `locked` (and nothing changes); our `packed-refs.lock` makes `git update-ref -d` fail. |
| R7 | A batch updating a packed ref, deleting a ref that is loose and stale-packed, and creating one, killed at every primitive call: every outcome is all old or all new; outcomes seen: crash→old, crash→new, completed→new. |
| R8 | The contract passes in Chromium (files on OPFS, SQL on sqlite-wasm, KV in memory) and inside a SQLite-backed Durable Object (SQL; KV over `sqlKvStore`). KV root for 10 000 refs: 762 KiB. |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 files: no phase 1 (loose refs not packed before the commit) | R6 interop (2 tests), R7 crash |
| M2 files: loose files removed before the phase-1 packed-refs commit | R7 crash |
| M3 files: expected old values ignored in multi-ref batches | contract on files (2 tests) |
| M4 SQL: expected old values ignored | contract on SQL, DO |
| M5 KV: `put` instead of root compare-and-set | 20-way concurrency on KV (3 tests) |
| M6 parent + child in one batch allowed | contract on every backend (7 tests) |
| M7 creates below/above existing refs allowed | contract on every backend (7 tests) |
| M8 names ending in `.lock` accepted | R1 (2 tests) and contract on every backend |
| M9 `@{` accepted | R1 (2 tests) and contract on every backend |
| M10 files: ref locks never released | contract on files, R7 |
| M11 SQL: reflog kept on delete | contract on SQL, DO |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| Plan: "git-files `.lock` + packed-refs" gives atomic transactions | Only with JGit's two-phase packed-refs commit; git's own files backend is not crash-atomic across refs. |
| Plan: "KV snapshot+root-cas vs per-key journal" — open | Root CAS works everywhere and is simplest; it is bounded by one value (~25 000 refs per DO value) and rewrites the root per batch. SQL is the DO choice; KV root CAS for small repositories and plain KvStores. |
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

`checkNames` and `checkBatch` (shared) apply git's name and conflict rules; each backend
dereferences symbolic refs, compares, and commits in its own atomic unit — one packed-refs rename,
one SQL transaction, or one root compare-and-set.

## Interfaces produced

```ts
interface RefDb {
  read(name): Promise<{ oid } | { symref } | undefined>;
  resolve(name): Promise<string | undefined>;
  list(prefix?): AsyncIterable<{ name; oid }>;
  batch(commands: RefCommand[], opts?: { ident?; message? }): Promise<BatchResult>;
  setSymref(name, target, expected?: string | null): Promise<boolean>;
  reflog(name): Promise<ReflogEntry[]>;
}
function filesRefDb(files: RefFiles, opts?: { refLockTimeoutMs?; packedLockTimeoutMs? }): RefDb;
function sqlRefDb(db: Db, prefix?: string): Promise<RefDb>;
function kvRefDb(kv: KvStore, root?: string): RefDb;
function checkRefFormat(name, { allowOneLevel? }): boolean;
interface RefFiles extends AtomicFiles { write(path, bytes); list(dir) }   // X2 + two methods
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

1. **FilesApi primitives upstream**: `createExclusive`, `replace` (X2) plus `write`-own-file and a
   recursive file `list` — the minimal set a git-compatible repository on FilesApi needs.
2. **Ref listing at scale on files**: `list` reads every loose file and packed-refs; a large
   repository needs packed-refs binary search (git's mmap'd sorted packed-refs) and lazy loose
   scanning.
3. **Multi-tab OPFS**: refs on OPFS rely on Web Locks for exclusive create; packed-refs commits use
   `createWritable` (atomic per file). Two tabs were not exercised here (X2 did 4 workers).
4. **Reflog atomicity** on files/KV (lines can be lost on a crash after commit) and reflog expiry.
5. **Reftable** as a later files format if crash-atomic transactions without packed-refs rewrites
   are needed at scale.
