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
- **Byte-exact formats** (the review found the first version lossy): tree names and modes are
  kept as read — latin-1 names, a BOM, legacy `040000` and `100664` modes round-trip to the same
  id — and new names follow git's fsck (`.git` in HFS+/NTFS spellings such as `.GIT`, `git~1`,
  `.git.`, `.g\u200Cit`; a symlinked `.gitmodules`; ill-formed strings; duplicates by bytes).
  Commits keep their extra headers in order (`gpgsig`, `mergetag`, `encoding`), the identity lines
  and the message bytes, written back while the parsed fields still match them; the message is
  decoded with its `encoding`; identities parse like git's `split_ident_line`, so the malformed
  ones `git log` tolerates do not abort a log.
- **Native git and other handles**: on a miss the pack directory is rescanned (git's
  `reprepare_packed_git`), so a `git gc` under an open repository, or a pack installed through
  another handle, is found; installs on a handle are serialised; a thin pack's base from the store
  is refused unread when over `maxObjectSize`; stale `tmp_*` of interrupted installs are swept at
  open (two weeks, git prune's age); the files backend reads its loose objects once.
- **Commands**: `log` peels annotated tags and stops at parents the store does not have (a shallow
  clone's boundary), reading each commit once; ordering matches `git log` with author and
  committer dates inverted, ties and skew; a read of the wrong type releases its stream (it leaked
  a pooled inflater and a file handle); `writeFiles` refuses a path that is a file and a directory;
  `commit` refuses a tree or parent the store does not have and an unreadable date.
- **X4 bug found and fixed**: `get(id, { verify: true })` on an absent id threw an id mismatch
  (the hash of nothing) instead of returning `undefined`. The git-files backend never asked for an
  absent loose object in a way that showed it; the SQL backend asks the pack database (whose
  loose half is empty there) first.

## Verified

All 24 Node tests pass (`pnpm test 17-repository`); X4's suite passes with the fix. The review's
findings got red tests first (12 of 13 failed on the reviewed code; the log-ordering one already
held and stays as a guard).

| # | Result |
|---|---|
| R1 | Both backends: put/get/has/list (git's ids for "a\n" and the empty blob); a native-git pack installed, every object equal to `git cat-file`; a thin pack of two commits editing a large file installed with more objects than it carried (bases appended from the store). |
| R2 | Identical ids, refs and logs on both backends; the stale CAS rejected; every tree and commit id — the merge too — equals `git mktree` / `git commit-tree` (a committer with a `-0130` zone, a message with a body). |
| R3 | `git fsck --full --strict` and `git log` on our history; git's history (15 commits) read through the command layer, loose and after `git gc`. |
| R4 | Bundled alone by esbuild (every import form counts; type imports vanish), `commands.ts` pulls in exactly `commands.ts` and `git-format.ts` (the first version's regex missed single quotes, `export … from`, dynamic imports — the review). `Repository` lives in `object-store.ts`; the backends are separate modules, so a git-files bundle carries no SQL code. |
| R5 | A Durable Object (SQLite storage): 4 commits with the same ids as on Node, the fixture pack received, its 40-commit history equal to native git's. |
| Review | Latin-1/BOM names and legacy modes round-trip; fsck-refused names refused; a gpgsig + ISO-8859-1 commit and a malformed-identity commit round-trip; malformed identities in `git log`'s history; log = `git log` with inverted dates, ties, skew; tag peeling; a shallow clone's log; `git gc` under an open handle and a second SQL handle (read with `get` first); writeFiles conflicts; commit existence checks; a released stream; an oversized thin-pack base refused unread. |

### Mutation check

| Mutation | Caught by |
|---|---|
| G1 tree order ignores git's "/" rule | R2 (the `lib.ts` / `lib` pair, added for it) |
| G2 commit's compare-and-swap dropped | R2 (stale update succeeds) |
| G3 log oldest first | R2, R3 |
| G4 thin packs not completed from the store | R1 (first not caught: the thin pack held only empty commits, nothing to complete; now it edits a large file) |
| G5 packs not reopened after an install | R1 |
| G6 X4's fix reverted | R1 (SQL backend) |
| H1 log by author date | log vs git with inverted dates (the review's surviving mutation) |
| H2 tree names re-encoded from the display string | latin-1/BOM names, legacy modes |
| H3 hasDotgit not checked | fsck-refused names |
| H4 raw identities not reused | malformed-identity round-trip (added after the first mutation run missed it) |
| H5 extra headers dropped | gpgsig + encoding round-trip |
| H6 no rescan on a miss | `git gc` under an open handle, second SQL handle (first not caught: both tests called `has`, which rescans too; now `get` first) |
| H7 tags not peeled | tag peeling |
| H8 missing parents not a boundary | shallow clone |
| H9 writeFiles conflicts not refused | writeFiles conflicts |
| H10 commit does not check existence | commit refusals |
| H11 wrong-type read not released | released stream |
| H12 external base not bounded | oversized base refused unread (first not caught: X6b2 refuses it too — after reading it; the test now counts the bytes read) |

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
| `src/git-format.ts` | **Adopt** | byte-exact tree/commit/tag encodings, checked against git |
| `src/composed-store.ts`, `src/files-repository.ts`, `src/sql-repository.ts` | **Adopt** | the backends |
| `src/object-store.ts` | **Adopt with changes** | X16b adds an AbortSignal to the long calls; X6c needs a header-only read and access to raw (deflated, possibly delta) pack entries to reuse them when exporting |
| `src/commands.ts`, `src/demo.ts` | **Source** | a first command layer; X16b adds worktree, abort, hooks, events |

## Open threads (ranked by how much later work they would invalidate)

1. **X16b**: worktree/index/checkout over FilesApi, AbortSignal, hooks, events, identity from
   config, a worker-hosted repository with a thin UI proxy.
2. **X6c**: pack export (for push and serve) — needs a reachable-objects walk, a header-only read
   (type, size) and raw entry access to reuse packed deltas instead of re-inflating and
   re-deflating everything; the `ObjectStore` interface grows by those.
3. A KV object backend (X5 has KV refs): the composition needs only a StagingBlobStore and a
   FilesApi for packs over KV.
4. `list()` holds every id in a Set to deduplicate packs and loose objects: fine for a prototype,
   a merge of two sorted streams later. Errors are module-specific (PackError, CorruptObjectError,
   ObjectIdMismatchError, Error): X16b's `VcsError.code` unifies them.
5. One repository per SQL Db (fixed table prefixes); opening re-reads the pack indexes — keep a
   handle per isolate.
