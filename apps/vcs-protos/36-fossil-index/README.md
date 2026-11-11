# 36 — Can SQL indexes give Fossil-like history queries, in the same transaction as the refs?

Plan id **X9** (Fossil-like capabilities). Status: **answered — yes: path history and message search from SQL tables equal git's on 40 random histories, the rows commit with the ref update or not at all, and each query answers in under 5 ms on 100,000 commits over 50,000 files**.

## Question

Fossil answers "which commits touched this file" and "which commits mention this word" from SQL
tables kept with the repository. In git these walk the whole history. webrun-vcs already keeps
repositories in SQL (X16a's `sqlRepository`): can it keep such indexes, written in the same
transaction as the ref update that makes the commits reachable, and answer as git does — fast?

## Reject condition

Rejected if a query answers differently from git (a commit missing, extra or out of order), if the
indexed and the unindexed (walking) answers differ, if a ref update can commit without its index
rows or index rows without the ref update, or if a query takes 100 ms or more on 100,000 commits
over 50,000 files.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| F1 | **Path history.** `pathHistory(path)` equals `git log --all --full-history --no-merges --format=%H -- <path>` on random histories (branches, merges, adds, edits, deletes, files becoming directories), for every path and directory prefix, both from the index and by walking the objects. |
| F2 | **Search.** `searchMessages(text)` equals `git log --all --no-merges --format=%H -F --grep=<text>` (case-sensitive, fixed string), for words, phrases, substrings shorter and longer than three characters, from the index (FTS5 trigram) and by walking. |
| F3 | **Same transaction.** The index rows of newly reachable commits are written inside the ref batch's transaction (`sqlRefDb`'s new `beforeCommit` hook): a failing indexer leaves neither the ref change nor any index row; a rejected batch writes no index row; each commit is indexed once however many refs reach it. |
| F4 | **Speed.** 100,000 commits over 50,000 files (indexed once): a path history and a search each answer in under 100 ms. |
| F5 | **Portable.** `src/` has no `node:` imports; the SQL is plain SQLite (FTS5 trigram, available in node:sqlite, sqlite-wasm and Durable Objects). |

## Scope

- `--no-merges`: merge commits are indexed (date, message, parents) but not listed; git's history
  simplification through merges (TREESAME pruning) is left out, hence `--full-history` in F1.
  (F1 first said `--no-merges` alone; the first run showed that git still simplifies through merges
  then, hiding commits on a side a merge discarded, so the criterion was corrected to the command
  that means "every non-merge commit that changed the path".)
- Commit dates in the corpora are distinct, so the order is by committer date alone.
- Commits are indexed when a ref batch makes them reachable; deleting a ref does not unindex.

## Answer

Yes. `src/fossil.ts` (about 290 lines, no `node:` imports) adds three tables to X16a's SQL
repository and a `beforeCommit` hook to X5's `sqlRefDb`. All 7 tests pass:

- **F1, path history.** On 40 random histories (branches, merges, adds, edits, deletes, files
  becoming directories), every path and directory prefix gives the same commits, in the same
  order, as `git log --all --full-history --no-merges -- <path>`, from the index and by walking.
- **F2, search.** Words, phrases, two-character and long substrings, absent text: the same as
  `git log --all --no-merges -F --grep`, from the index and by walking.
- **F3, same transaction.** A failing indexer leaves neither the ref nor any row; a rejected batch
  writes no row; a commit reached by a second ref is not indexed again; concurrent batches on one
  handle each index their own commits, and on two handles over one database none is indexed twice.
- **F4, speed.** 100,000 commits over 50,000 files: a file's history in 0.6 ms, a directory's in
  0.6 ms, a search in 4.6 ms (node:sqlite).

**The tables:**
- `fossil_commit`: each indexed commit once, with its committer date, whether it is a merge, and
  its message.
- `fossil_change`: for each non-merge commit, the file paths that differ from its parent (all of
  them for a root commit). A path query is one indexed range: `path = p OR p/ <= path < p0`.
- `fossil_text`: an FTS5 trigram index of the messages, case-sensitive like `--grep`. Text of three
  characters or more goes through it (then `instr` confirms); shorter text scans the messages.

**Same transaction, without a deadlock.** The first version read objects inside the hook. With a
SQL object store that shares the database, those reads queued behind the transaction itself and
the batch hung. Now indexing has two halves: `prepare` walks the new commits and computes their
rows before the batch (reading objects); the hook only writes them, skipping commits another handle
indexed in between. Batches on one handle run one at a time, so each hook writes its own rows.

**Indexing speed (a finding for X6r).** Computing the rows by reading our objects costs about
3 ms a commit on the fast-import corpus, and more on its newest commits: about 370 commits a second,
some 13 minutes for 100,000. Plain reads of commits and root trees are 0.4 ms each; the cost is in
the deeper tree reads of X6r's pack reader on this pack. F4 therefore builds its rows from git's own
log (`--root --name-only`), since what it measures is the queries on tables of that size; F1–F3
build them through our objects.

### Mutation check

| # | Mutant | Result |
|---|---|---|
| P1 | Directory prefixes not matched | killed (F1) |
| P2 | Merges found by search | killed (F2) |
| P3 | Oldest first | killed (F1) |
| P4 | Deleted files not counted as changes | killed (F1) |
| P5 | No descent where one side is a file | killed (F1) |
| P6 | No hook (refs without rows) | killed (F1, F3) |
| P7 | Rows written without checking for another handle's | survived; killed by F3's two-handle case |
| P8 | Batches on one handle not one at a time | survived; killed by F3's one-handle case over unrelated histories |
| P9 | Short text through FTS (trigrams need three characters) | killed (F2) |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/fossil.ts` | **Adopt** (merge simplification, unindexing on ref deletion to come) | git's answers from SQL, committed with the refs |
| `sqlRefDb`'s `beforeCommit` | **Adopt** | the seam for anything that must commit with the refs |

## Open threads

1. git's default history simplification through merges (TREESAME pruning, `--simplify-merges`).
2. Unindexing commits a deleted ref leaves unreachable (or keeping a reachability column).
3. Indexing speed: X6r's deeper tree reads on fast-import packs.
4. Search across all refs only: per-branch answers need reachability (a commit-graph's generation
   numbers would bound the walk).
