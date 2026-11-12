# 36 — Can SQL indexes give Fossil-like history queries, in the same transaction as the refs?

Plan id **X9** (Fossil-like capabilities). Status: **answered — yes: path history and message search from SQL tables equal git's on 40 random histories, the rows commit with the ref update or not at all, and each query answers in under 5 ms on 100,000 commits over 50,000 files**. X9b adds git's default history simplification (`simplifiedPathHistory`, equal to `git log --all --no-merges -- <path>`). Limits: literal paths, git's order only where commit dates are distinct and fall from child to parent, and answers stay as they were after a ref is deleted or rewound (no unindexing yet); building the rows through our objects runs at about 370 commits a second.

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
| F6 | Added after review: refs to annotated tags (peeled) and to a blob (skipped); pathspec forms `d/`, `./d`, `d/.`, `.` as git reads them, and globs, `:(magic)` and the empty pathspec refused; search text with newlines (any of its lines; an empty line matches all); text of three UTF-16 units but two characters kept off the trigram index; equal commit dates give the index and the walk one order. |
| F5 | **Portable.** `src/` has no `node:` imports; the SQL is plain SQLite (FTS5 trigram, available in node:sqlite, sqlite-wasm and Durable Objects). |
| F1b | (X9b) **git's default simplification.** `simplifiedPathHistory(path, tips)` equals `git log --all --no-merges --format=%H -- <path>` (no `--full-history`) on 40 random histories — half of them built so the simplification matters: side branches merged as usual, with `-s ours`, after the same change on both sides, with an edit reverted on one side, most deleted after their merge — for every path and directory, from the index and by walking (`walkSimplifiedPathHistory`); at least 10 answers differ from `--full-history`'s. |
| F1c | (X9b) Commits indexed after the walk's parent graph was loaded are walked by the next query. |
| F4b | (X9b) On F4's 100,000 commits a simplified path history answers in under 100 ms once the parent graph is loaded. |
| F7 | (X9c) **Per-branch answers.** With `tips`, `pathHistory` equals `git log --full-history --no-merges <ref> -- <path>`, `simplifiedPathHistory` `git log --no-merges <ref> -- <path>` and `searchMessages` `git log --no-merges -F --grep <ref>`, for every ref of 40 histories; after a ref is deleted (rows kept), the current refs as tips give `git log --all`'s answers. Under 100 ms from a tip on F4's corpus. |

## Scope

- `--no-merges`: merge commits are indexed (date, message, parents) but not listed. `pathHistory`
  is `--full-history`; `simplifiedPathHistory` (X9b) is git's default TREESAME pruning, from the
  tips given. `--simplify-merges` and parent rewriting (`--parents`, `--graph`) are not done.
  (F1 first said `--no-merges` alone; the first run showed that git still simplifies through merges
  then, hiding commits on a side a merge discarded, so the criterion was corrected to the command
  that means "every non-merge commit that changed the path".)
- Order: newest first by committer date, then by commit id, the same for the index and the walk.
  It is git's order wherever dates are distinct and fall from child to parent (the corpora's); with
  skewed or equal dates git's walk (a parent never before its child) can differ.
- Literal paths only: globs and pathspec magic are refused, not matched literally.
- Commits are indexed when a ref batch makes them reachable; deleting a ref does not unindex.

## Answer

Yes. `src/fossil.ts` (about 290 lines, no `node:` imports) adds three tables to X16a's SQL
repository and a `beforeCommit` hook to X5's `sqlRefDb`. All 12 tests pass:

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

**Indexing speed (a finding for X6r).** Computing the rows by reading our objects cost about
3.75 ms a commit on the fast-import corpus (50,000 files): some 6 minutes for 100,000. The cost was
X6r opening the pack twice per object read. With X6r's block cache (follow-up) it is 1.34 ms a
commit, about 2 minutes for 100,000. F4 therefore builds its rows from git's own
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

### X9b: git's default history simplification

`simplifiedPathHistory(path, tips)` lists what `git log --no-merges -- <path>` lists from `tips`
(the refs and HEAD for `--all`): a merge that is TREESAME to a parent for the path — no file
under it differs — is followed through its first such parent only (git's
`try_to_simplify_commit`), so a side that a merge discarded (`-s ours`, a change made on both
sides, an edit reverted) is not walked, and its commits are not listed unless another tip
reaches them. Two more tables hold what the walk needs: `fossil_parent` (every commit's parents,
in order) and `fossil_merge_change` (for each merge and each parent, the file paths that differ
from it, indexed by path). A query fetches the merges' differing parents for the path in one
range, walks from the tips in memory, and keeps the `--full-history` answer's commits it reached.

- **F1b**: 346 paths over 40 histories (half built so the simplification matters), 57 of them
  answered differently from `--full-history`: every answer equals git's, indexed and walked.
- **Speed (F4b)**: a recursive CTE did the walk in 808 ms on 100,000 commits. The walk now runs
  over an in-memory parent graph by integer id: 4.9 ms per query once loaded; the first query
  loads the graph (100,000 rows, about 0.5 s) and later ones only take in the rows added since (a
  rowid watermark). A commit the graph lacks is read from the table, so the cache saves queries
  and never changes an answer (F1c), and a commit not indexed yet is not cached.
- **Storage**: a merge stores its differences from each parent, which for a merge of a long side
  branch is that branch's whole change set.

| # | Mutant | Result |
|---|---|---|
| S1 | No simplification (every parent followed) | killed (F1b) |
| S2 | The last TREESAME parent instead of the first | killed (F1b) |
| S3 | A merge's difference matched for the exact path only (not under a directory) | killed (F1b) |
| S4 | Neither the watermark refresh nor the read on a miss | killed (F1c) |
| S5 | No watermark refresh (the read on a miss alone) | survived, as designed: the refresh only saves queries |

**Review of #119** confirmed the rule against git's `revision.c` (`try_to_simplify_commit`;
`REV_TREE_NEW` special only with `--remove-empty`; no default post-pass) and on octopus,
unrelated-history, file/directory, criss-cross and mode-only merges, and found around it:

| Finding | Fix (test F1d unless noted) |
|---|---|
| Annotated-tag tips not peeled: a commit only a tag reaches was missing | tips peeled (indexed commits as they are, tags followed, blobs and trees skipped); an id that is no object is refused. `mergyHistory` now tags a commit only the tag reaches (F1b) |
| A query during an index write (same connection, inside its transaction) cached commits whose parent rows were not written yet as roots, for good | commit rows written after their parents and differences, and a commit cached only once all its parent rows are seen (`fossil_commit.parents`); either guard alone holds, both removed fail the test |
| An index written before X9b read every commit as a root | the `parents` column added on open, and the parents and merge differences of commits without it read from the objects once per handle |
| An unindexed tip or parent silently ended the walk | refused with "not indexed" |

| # | Mutant | Result |
|---|---|---|
| T1 | Commit rows written before their parents | survived alone (T2 holds); with T2, killed |
| T2 | Cached without checking the parent count | survived alone (T1 holds); with T1, killed |
| T3 | No backfill | killed |
| T4 | Tips not peeled | killed (F1b) |
| T5 | A missing tip skipped | killed |
| T6 | The differences read before the refresh | survived: the window (a write between the two queries of one walk) is not exercised |

Not modelled: `refs/replace` and grafted or shallow parents (git follows replace refs by default).

### X9c: per-branch answers

`pathHistory(path, { tips })` and `searchMessages(text, { tips })` keep the commits `tips` reach
(every parent followed, over X9b's in-memory parent graph); `simplifiedPathHistory` already took
tips. One ref gives that branch's history (`git log <ref> -- <path>`); the current refs and HEAD
give `--all` without what deleted or rewound refs left behind, which answers open thread 2 for
queries while the rows stay. F7: every ref of the 40 histories, 2,000+ answers, all equal to
git's; on 100,000 commits a path history and a search from a tip take 9 ms together. A merge read
on a miss during a walk (indexed after the walk began) has its differences read before the walk,
the window T6 names.

| # | Mutant | Result |
|---|---|---|
| U1 | `pathHistory` ignores `tips` | killed (F7) |
| U2 | `searchMessages` ignores `tips` | killed (F7) |
| U3 | The walk follows first parents only | killed (F7) |
| V1 | (review of #120) A pattern with an empty line not limited to the tips | killed (F7) |
| V2 | `tips: []` read as "no limit" (it reaches nothing) | killed (F7) |
| V3 | A tree or blob tip walked instead of skipped (`git log <tree>` lists nothing) | killed (F7) |

Review of #120 also: an id that is no object is refused with a message saying tips are object
ids; a query with no candidate row returns before walking (no walk, no "not indexed" error for a
query that matches nothing); F7 checks that deleting a ref narrows `--all` in practice. Order on
equal dates is by id, which git's walk is not (nor, with clock skew, a pure date sort): not
modelled, as before.

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/fossil.ts` | **Adopt** (unindexing on ref deletion to come) | git's answers from SQL, committed with the refs |
| `sqlRefDb`'s `beforeCommit` | **Adopt** | the seam for anything that must commit with the refs |

## Open threads

1. ~~git's default history simplification through merges~~ — answered by X9b
   (`simplifiedPathHistory`, F1b). `--simplify-merges` (the parent-rewriting variant) is not done.
2. ~~Unindexing commits a deleted ref leaves unreachable~~ — answered for queries by X9c: with
   `tips` (the refs left, and HEAD) nothing only a deleted or rewound ref reached is listed. The
   rows themselves stay (storage, not answers); dropping them is X18's gc.
3. Indexing speed: X6r's deeper tree reads on fast-import packs.
4. ~~Search across all refs only~~ — answered by X9c: `pathHistory` and `searchMessages` take
   `tips` (one branch, several, or the current refs), walking X9b's parent graph (9 ms for a path
   and a search on 100,000 commits). Generation numbers would let a walk stop early; not needed at
   that speed.

### Review

| Finding | Fix |
|---|---|
| A ref to an annotated tag (or to a blob) made every batch throw | tags peeled, other objects skipped (F6) |
| Order with skewed or equal dates matched neither git nor the other method | one order (date, then id) for both; the limit stated (F6, Scope) |
| Pathspecs taken literally: `d/`, `./d`, `.` found nothing, `a*` only itself | git's forms normalised; globs, magic and the empty pathspec refused (F6) |
| Search text with newlines matched as one string | split into lines, any of which matches (F6) |
| `"é😀"` (three UTF-16 units) sent to the trigram index | characters counted (F6) |
| Tree names that are not UTF-8 could collide | entries keyed by their bytes |
| Stale answers after a ref is deleted or rewound | stated in the status line; an open thread |
| Docs: `--full-history` in the source, `beforeCommit`'s `updates` | corrected |
