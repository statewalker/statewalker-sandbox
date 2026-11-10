# 17 — Can one repository API run unchanged over git files and over a single SQL database?

Plan id **X16** (repository façade & contracts), slice **X16a: one ObjectStore, one RefDb, one
command layer**. Status: **answered — yes: one command layer, importing only the interfaces, gives the same ids (git's) and histories over git files and one SQL database, interoperates with native git, and runs in a Durable Object.**

## Question

The prototypes so far built the parts: objects (X4 loose, X6r packs, X3b SQL rows), refs (X5),
pack ingest (X6b1/X6b2). Can they be composed behind two small interfaces — an `ObjectStore`
(loose objects + packs) and X5's `RefDb` — so that a command layer (write a tree, commit, move a
branch with compare-and-swap, read the log, receive a pack) runs **unchanged** over

- **git files** (any FilesApi rooted at `.git`, native git reading and writing the same files), and
- **one SQL database** (refs in X5's tables, loose objects in X3b's rows, packs kept as packs in
  SqliteFilesApi tables of the same Db — X6b3's decision),

producing the same object ids as git, in Node and in a Durable Object?

## Reject condition

Rejected if the command layer needs a backend-specific branch or import, if the two backends give
different ids or histories for the same commands, if ids differ from git's, or if native git
cannot read (or our layer cannot read) the other's repository.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | One `ObjectStore` contract (put/get/has/list, install a pack — completing a thin pack from the store itself) passes on both backends; objects of installed native-git packs read back as `git cat-file`. |
| R2 | The same command sequence (blobs, nested trees, a commit chain with a merge, branch moves with compare-and-swap, a rejected stale update) on both backends gives identical object ids, refs and logs; tree and commit ids equal native git's (`git mktree` / `git commit-tree` on the same input). |
| R3 | Interop on Node files: a history written by the command layer passes `git fsck --full` and `git log` equals ours; a repository written by native git (loose and packed after `git gc`) gives the same log through the command layer. |
| R4 | The command layer imports no concrete backend (statically checked): only the `ObjectStore` and `RefDb` interfaces and pure git-format code. |
| R5 | In a Durable Object, the SQL backend runs the command sequence, installs X6a's fixture pack and reads its history. |

## Scope — what this slice does NOT do

- Worktree/index/checkout, AbortSignal, hooks, events, identity from config, a worker proxy — the
  rest of X16.
- KV backend for objects (refs on KV exist in X5); gc (X18); pack export (X6c).

## Answer

**Yes.** Two interfaces carry everything: `ObjectStore` (put/get/has/list/installPack) and X5's
`RefDb`. Both backends are the **same composition** — packs on a FilesApi (installed by X6b2,
read by X6r) plus loose objects through X4's kernel — over different storage:

| | packs | loose objects | refs |
|---|---|---|---|
| `filesRepository(files, refFiles)` — git files | `.git/objects/pack` on the FilesApi | `.git/objects/xx/…` on the same FilesApi (X4) | X5 `filesRefDb` (git's layout) |
| `sqlRepository(db)` — one SQL database | SqliteFilesApi tables `pk_*` in the Db | X3b rows `obj_*` (X4 over X3b) | X5 `sqlRefDb` (`refdb_*`) |

The command layer (`writeFiles`, `writeTree`, `commit` with compare-and-swap, `log`, `readTree`,
`readCommit`, `receivePack`) imports the interfaces as types and the pure git-format module, and
nothing else (checked statically). Reads consult packs first, then loose objects (git's
find_pack_entry); a received thin pack is completed from the store itself.

- The same command sequence — nested trees (including a file `lib.ts` beside a tree `lib`, where
  git's "a tree sorts as `name/`" rule decides the order), a commit chain with a merge, branch moves,
  a stale compare-and-swap rejected — gives identical ids, refs and logs on both backends, and the
  ids equal `git mktree` / `git commit-tree`'s.
- On Node files our history passes `git fsck --full --strict` and `git log`; a repository native
  git wrote — loose, then packed by `git gc` — gives git's log through the command layer.
- In a Durable Object the SQL backend commits, receives X6a's fixture pack and reads its history
  as native git does.
- **X4 bug found and fixed**: `get(id, { verify: true })` on an absent id threw an id mismatch
  (the hash of nothing) instead of returning `undefined`. The git-files backend never asked for an
  absent loose object in a way that showed it; the SQL backend asks the pack database (whose
  loose half is empty there) first.

## Verified

All 10 Node tests pass (`pnpm test 17-repository`); X4's suite passes with the fix.

| # | Result |
|---|---|
| R1 | Both backends: put/get/has/list (git's ids for "a\n" and the empty blob); a native-git pack installed, every object equal to `git cat-file`; a thin pack of two commits editing a large file installed with more objects than it carried (bases appended from the store). |
| R2 | Identical ids, refs and logs on both backends; the stale CAS rejected; tree and commit ids equal `git mktree` / `git commit-tree` (a committer with a `-0130` zone, a message with a body). |
| R3 | `git fsck --full --strict` and `git log` on our history; git's history (15 commits) read through the command layer, loose and after `git gc`. |
| R4 | `commands.ts` imports `./git-format.js` and type-only `./repository.js`, `../../10-ref-transactions/src/ref-db.js`. |
| R5 | A Durable Object (SQLite storage): 4 commits, the fixture pack received, its 40-commit history equal to native git's. |

### Mutation check

| Mutation | Caught by |
|---|---|
| G1 tree order ignores git's "/" rule | R2 (the `lib.ts` / `lib` pair, added for it) |
| G2 commit's compare-and-swap dropped | R2 (stale update succeeds) |
| G3 log oldest first | R2, R3 |
| G4 thin packs not completed from the store | R1 (first not caught: the thin pack held only empty commits, nothing to complete; now it edits a large file) |
| G5 packs not reopened after an install | R1 |
| G6 X4's fix reverted | R1 (SQL backend) |

## Interfaces produced

```ts
interface ObjectStore {
  put(type, content: Uint8Array): Promise<string>;
  get(oid, opts?: { verify? }): Promise<{ type; size; content: AsyncIterable<Uint8Array> } | undefined>;
  has(oid): Promise<boolean>; list(): AsyncIterable<string>;
  installPack(source): Promise<{ packId; count }>;
}
interface Repository { objects: ObjectStore; refs: RefDb }          // X5's RefDb
filesRepository(files: FilesApi, refFiles: RefFiles, objectsDir?): Promise<Repository>;
sqlRepository(db: Db): Promise<Repository>;
// commands.ts: writeBlob, writeTree, writeFiles, readTree, readCommit, commit, log, receivePack
// git-format.ts: encodeTree/parseTree, encodeCommit/parseCommit
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/object-store.ts`, `src/repository.ts` | **Adopt** | the backend seam of webrun-vcs |
| `src/git-format.ts` | **Adopt** | git's tree/commit encodings, checked against git |
| `src/commands.ts` | **Source** | a first command layer; X16b adds worktree, abort, hooks, events |

## Open threads (ranked by how much later work they would invalidate)

1. **X16b**: worktree/index/checkout over FilesApi, AbortSignal, hooks, events, identity from
   config, a worker-hosted repository with a thin UI proxy.
2. **X6c**: pack export (for push and serve) — the object store has to enumerate a commit range.
3. A KV object backend (X5 has KV refs): the composition needs only a StagingBlobStore and a
   FilesApi for packs over KV.
4. `list()` holds every id in a Set to deduplicate packs and loose objects: fine for a prototype,
   a merge of two sorted streams later.
