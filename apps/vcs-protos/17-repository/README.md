# 17 — Can one repository API run unchanged over git files and over a single SQL database?

Plan id **X16** (repository façade & contracts), slice **X16a: one ObjectStore, one RefDb, one
command layer**. Status: **open**.

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
