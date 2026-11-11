# 36 — Can SQL indexes give Fossil-like history queries, in the same transaction as the refs?

Plan id **X9** (Fossil-like capabilities). Status: **open**.

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
