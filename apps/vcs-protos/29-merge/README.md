# 29 — Can one diff and merge engine produce git merge-tree's trees, conflicts and markers?

Plan id **X13** (single diff and merge engine), slices **X13a: git's content merge, byte for
byte** (answered — yes: a port of git's xdiff matches `git merge-tree` byte for byte on every case)
and **X13b: the tree merge without renames** (answered — yes: identical trees, conflicted entries
and messages to `git merge-tree -Xno-renames` on 2,307 cases).

## Question

webrun-vcs has three merges: `tree-merge.ts` works path by path, with no content merge and no
renames, so any path both sides changed is a conflict; `merge-command` is entry-level with a
content merge; and `merge-algorithm.ts` is JGit's three-way text merge over JGit's Myers and
histogram diffs. git has one, `ort`, which `git merge-tree --write-tree` runs without a worktree.
It writes the merged tree, including the conflicted files' blobs with their markers.

The engine must give git's results exactly, so it must use git's algorithms, not JGit's. Three
differences make JGit's merge produce other bytes:
- merge-ort sets histogram diff, and git's histogram (`xhistogram.c`) is a different algorithm
  from JGit's;
- `xdl_merge` runs at the `ZEALOUS` level, refining conflicts by diffing the two sides and joining
  conflicts at most three lines apart;
- git conflicts on changes to adjacent lines.

Can a TypeScript port of git's xdiff produce, for any three versions of a file that git can merge,
the bytes and the clean or conflicted result that `git merge-tree` writes? Histogram's chain limit
makes git fail some merges outright; there the port throws `XdiffLimitError`.

Slices:
- **X13a (this):** the content merge.
- **X13b:** the tree merge (ort's conflict kinds, directory/file collisions, modes).
- **X13c:** renames and criss-cross merges.

## Reject condition

Rejected if, on any case of the corpus, a merged blob differs from the one in
`git merge-tree --write-tree`'s tree by even one byte, or a merge is clean here and conflicted there
(or the reverse).

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| M1 | Hand-made cases, byte-identical to `git merge-tree`, with the same clean flag: separate edits, the same line changed differently, identical changes, adjacent lines, conflicts near each other, overlaps that differ in part, insertions at the same place, a side deleting everything, add/add from an empty base, a missing final newline (clean and conflicted), CRLF markers, binary files (ours kept, conflict), and lines repeated past histogram's 64-occurrence limit. |
| M6 | 400 random merges of small files over small alphabets (lines repeat, as in code; 10% without a final newline; 10% with identical sides): every blob and clean flag equal to git's. |
| M6b | 60 merges of 300–3000 lines with heavy repetition and many edits (histogram's fallback to the classic algorithm). |
| M6d | The classic algorithm's discards: 4000 merges mixing frequent lines with lines unique to one side (added after the mutation check, see below). |
| M6c | The classic algorithm's heuristics: inputs whose edit cost passes the cost limit, and one of about 35,000 lines a side, where the limit exceeds 256 and the snake heuristic runs. |
| M7 | Portable: no `node:` imports; one module for diff (`xdiff.ts`) and one for merge (`xmerge.ts`). |

## Scope

- The diff3 and zdiff3 styles, `-Xours`/`-Xtheirs`/union, whitespace flags, `merge.conflictstyle`:
  git's defaults only. Patience diff and the indent heuristic (merge-ort sets neither) are out.

## Answer

Yes. `src/xdiff.ts` and `src/xmerge.ts` (about 1100 lines, no `node:` imports) port git
v2.43.0's xdiff on the path merge-ort takes:
- `xprepare.c`: lines and their classes; the trimming and discards the classic algorithm uses.
- `xhistogram.c`: the histogram diff, with its fallback.
- `xdiffi.c`: Myers with git's middle-snake heuristics and cost cutoff; `xdl_change_compact`;
  the edit script.
- `xmerge.c`: `xdl_merge` at `ZEALOUS`, with conflict refinement, joining of near conflicts,
  CRLF-aware markers and the final newline added inside conflicts.
- `merge-ll.c`: the binary check.

Every case matches `git merge-tree --write-tree --stdin`: the merged blob is identical byte for
byte, and the clean flag is the same.

| # | Result | How |
|---|---|---|
| M1 | ✅ | 14 hand-made cases. |
| M6 | ✅ | 400 random merges; 206 of them conflict (225 hunks). |
| M6b | ✅ | 60 large merges; histogram's fallback runs 64 times. |
| M6c | ✅ | 16 merges built to reach the classic algorithm's limits: the cost cutoff runs 96 times, and the snake heuristic 63 times. The heuristic needed a merge of about 35,000 lines a side, because it only runs once the cost limit is above 256, which takes more than 65,536 diagonals. |
| M6d | ✅ | 4000 merges in which the classic algorithm discards lines. |
| M7 | ✅ | Two portable modules. |

The branch counts were measured with temporary counters, which were then removed.

### Why not JGit's merge

webrun-vcs's `merge-algorithm.ts` uses JGit's histogram diff, which is a different algorithm from
git's. It has no zealous refinement, and it treats changes to adjacent lines as separate, where git
conflicts. An engine meant to give git's trees has to give git's bytes, so it ports git.

### Mutation check

13 mutants. 10 were killed at once. D5 survived because no corpus produced a case where the
classic algorithm discards a line. A differential search against the unmutated port found
distinguishing inputs, and with M6d added D5 is killed. D6 and D11 showed no difference on 4,000
targeted random merges. They are equivalent as far as testing can tell, and both are kept because
they are git's code.

| Mutant | Result |
|---|---|
| D1 no compaction | killed |
| D2 groups not aligned with the other side's | killed |
| D3 histogram's tie rule (`rc < cnt`) dropped | killed |
| D4 no fallback to the classic algorithm | killed |
| D5 the classic algorithm keeps every line (no discards) | killed by M6d |
| D6 the classic algorithm does not trim the common ends | no difference found (`xdl_recs_cmp` shrinks them anyway) |
| D7 the cost cutoff always takes the forward path | killed |
| D8 conflicts not refined | killed |
| D9 no CRLF markers | killed |
| D10 binary merged as text | killed |
| D11 touching hunks not joined in `xdl_append_merge` | no difference found |
| D12 identical changes conflict | killed |
| D13 no newline added at the end of a conflict side | killed |

### git versions: compaction changed in 2.54

CI (git 2.56) differed from this sandbox (git 2.43) on about 0.4% of the corpus. git 2.54 added a
step to `xdl_change_compact`: under histogram diff, a group of changes that slid, and that lines up
with a group on the other side, is diffed again with the classic algorithm. The release was found
by checking which tags' `xdiffi.c` carry the step: 2.53.0 does not, 2.54.0 does. Between 2.43 and
2.56 the rest of xdiff changed in form only: records stored by value, `rchg` renamed `changed`, a
faster line hash. The one other behavioural change is that an empty label no longer gets a space
after the marker.

The port gives git ≥ 2.54's result by default, and git ≤ 2.53's with `{ legacyCompaction: true }`.
The tests ask the installed git for its version and pass the matching option. CI's git 2.56 checks
the new path and this sandbox's git 2.43 the old one, so both are checked against a real git.
Building git 2.56 here to check both in one place was not permitted (code from outside the project).

### Review (#93)

A separate review compared the port line by line with the C and ran about 53,000 differential merges
against `git merge-tree`, with generators of its own:
- byte noise;
- CRLF, CR-only and LF/CR mixes;
- lines of up to 41 KB;
- file ends;
- bytes 0x80–0x9F and NUL past byte 8000;
- block moves.

Its fuzzer caught deliberately planted bugs (forced CRLF markers; an off-by-one in histogram's
fallback). It found one class of divergence and some robustness points. All are fixed:

| Finding | Fix |
|---|---|
| Binary files: merge-ort's trivial merges come first (ours = theirs or ours = base → theirs; theirs = base → ours, all clean), before the binary check. We conflicted, and sometimes kept the wrong bytes (81 mismatches across the fuzz runs) | The trivial merges come first, as in `handle_content_merge`; three M1 cases |
| Joining refined conflicts was quadratic (an array splice per join) | One pass, as git's list walk. 400,000 joins take 114 ms, against 49.5 s quadratic |
| Histogram's chain limit (64 distinct lines in one bucket) is reachable: git fails the merge ("failed to execute internal merge"); ours threw a plain `Error` | `XdiffLimitError`; documented in the question |
| The test's merge-tree parser could hang on a misread token | Status, tree id, message counts and full consumption checked |
| Files over git's `MAX_XDIFF_SIZE` (1023 MiB) are merged as binary; the port had no size rule | Same rule |
| `TextDecoder("latin1")` is missing in some engines | A char-code fallback for the line keys |

The review confirmed several points as faithful:
- index offsets and the sentinels;
- `xdl_split`'s reads only of values written in the same call, so its uninitialised C memory cannot
  diverge;
- the fallback's re-preparation of the sub-range;
- refinement, mode 4, and the CRLF rules.

It measured a recursion depth of at most 168, so there is no stack risk. Pathological inputs of
100,000 lines take 2–4 times git's time. Histogram's own quadratic case (an LCS of 5 lines each
time) is 5 times slower than C, from allocations; that is an open thread.

## X13b — the tree merge (without renames)

### Question

Given the merged blobs from X13a, can the tree merge around them produce what
`git merge-tree --write-tree` writes when no renames are involved? That means the same tree id; the
same conflicted entries (mode, blob, stage, path); and the same conflict messages, with the paths
they name. merge-ort decides path by path (`process_entry`), and its conflict kinds are:
- content and add/add;
- modify/delete;
- distinct types (a file against a symlink or submodule);
- file/directory, where the file moves to `path~<branch>`.

It also takes shortcuts that change what gets reported, such as resolving a directory one side left
untouched without looking inside it.

### Reject condition

Rejected if, on any case of the corpus, the tree id, a conflicted entry or a message differs from
`git merge-tree --write-tree -Xno-renames`, or a merge is clean here and conflicted there.

### Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| T1 | 400 random tree merges (paths up to 3 deep over 4 names; regular, executable and symlink entries; edits, deletions, mode flips, files becoming directories and back): the tree id, the conflicted entries and the messages are equal to git's. |
| T1b | 1000 more random merges from another seed, compared the same way. |
| T2 | The corpus reaches every conflict kind in scope: git reports content, add/add, modify/delete, distinct types and file/directory conflicts in it. |
| T3 | Portable: `src/merge-trees.ts` has no `node:` imports. Objects are read and written through the `Repository` of 17. |
| T4 | Hand-made cases the random corpus rarely reaches: a symlink that both sides turn into regular files, with three different modes and a two-way content merge. Added after the mutation check, see below. |
| T1c–e, T5 | Added after the review (see below), with branches as refs (`o<i>`, `t/<i>`) so paths can collide with `path~<branch>` names. T1c: 400 merges with such collisions. T1d: 300 merges where a file becomes a directory of up to 12 files. T1e: 200 merges of unrelated histories. T5: the review's 4 reproducers. |

### Scope

- Renames are X13c. git 2.43's merge-tree ignores `-Xno-renames`, so the corpus gives every new file
  content of its own and git finds no renames.
- Submodules (gitlinks) are out: there is no submodule merge. Only one merge base is handled.

### Answer

Yes. `src/merge-trees.ts` (about 400 lines, no `node:` imports) gives the same tree id, conflicted
entries and messages as `git merge-tree --write-tree -Xno-renames` on all 2,307 cases: T1's 400,
T1b's 1,000, T1c's 400, T1d's 300, T1e's 200, T4's 3 and T5's 4. The random corpora reach every
conflict kind in scope. In T1 and T1b, git reported:

| Conflict kind | Count |
|---|---|
| modify/delete | 367 |
| file/directory | 310 |
| content | 77 |
| add/add | 27 |
| distinct types | 12 |

A separate run of 3,000 cases from two other seeds also matched.

The merge follows merge-ort's `process_entry` path by path:
- **One side changed the path, or both changed it alike:** that version is taken, deletions included.
- **Both sides changed it:** `handle_content_merge` runs.
  - Modes: a mode differing from the base wins. Two different changed modes conflict, keeping ours.
  - Content: regular files go through X13a, two-way when the base has another type. A symlink keeps
    ours and conflicts.
- **modify/delete:** the surviving version stays in the tree. The message has git's two spaces
  before "Version".
- **Distinct types:** the regular file moves to `path~<branch>`; when neither side is a regular file,
  both move. Stage 1 is kept only for the side whose type matches the base.
- **File/directory:** a file that lands where the merged tree keeps a directory moves to
  `path~<branch of the file>`, made unique as `unique_path` does (`_0`, `_1`, …). This happens
  before its own merge. A moved file that merges to a deletion is clean, but git still prints the
  message.
- **Messages:** each is rendered with the path it ends at. They are sorted by that path, and a
  stable sort keeps a path's own messages in git's order (file/directory first).

Five behaviours were found only by differential testing against git:
1. **Trivial directory merges.** `collect_merge_info_callback` defers a directory that one side left
   exactly as in the base, or that only one side has. `handle_deferred_entries` then takes the other
   side's directory whole, without looking inside, so a file at that path is dropped with no
   file/directory message. It does this only when rename detection cannot need a source deleted on
   that side.
   - A deletion is a relevant source when the other side changed the file too, or deleted it as well.
   - A deletion is also relevant inside a directory that one side removed and the other side added a
     file to (`dir_rename_mask` = 0x07).
   - Without this rule, git cleanly drops a file our merge would move.
2. **A moved file that merges to a deletion is clean.** `is_null` in the `match_mask` branch.
3. **git 2.43's merge-tree ignores `-Xno-renames`.** The corpus therefore never reuses a deleted
   file's content.
4. **ort redoes the collection after renames** (found by the review). When walking the deferred
   directories at least triples the paths ort holds, it runs rename detection, caches every answer
   and collects again. Every relevant deletion is then known, so every directory deferred in the
   first walk is resolved whole, with no file/directory message. Four new files under a former file
   are enough to trigger it. git cancels the redo past the rename limit (7,000² candidate pairs),
   which these tests cannot reach.
5. **`unique_path` avoids every path ort holds** (found by the review). That includes directories
   any side has at that level, even ones the merge deletes. It does not avoid only the paths of the
   result.

### Review (#95)

A separate review compared the port with merge-ort.c and ran about 7,900 differential merges from
its own generators:
- trees up to 6 deep;
- wide directories and directories of 3–17 files;
- many file/directory flips;
- executables and symlinks;
- binary contents;
- identical changes on both sides;
- unrelated histories;
- branch names with `/`;
- names colliding with `path~<branch>`.

| Finding | Fix |
|---|---|
| A moved file's name ignored directories only the base or a dropped side has (`x~O/` deleted by the merge; git moves to `x~O_0`) | The check covers every file and directory of all three sides and the names made so far; T5 and T1c |
| ort's redo after renames (more paths after the deferred directories than 3 times before) resolves every deferred directory whole; we reported file/directory moves git never prints | The redo rule above; T5 and T1d |
| Conflicts and messages sorted by UTF-16 units; git compares bytes (characters past U+FFFF) | Byte order; T5 |
| Legacy modes (`100664`) kept; git's `canon_mode` writes `100644` | `canon_mode`; T5 |
| Comparing directories built a signature by scanning every path for each directory (quadratic: 24.8 s for 20k files in 4k directories, against git's 0.45 s) | Tree ids recorded while reading the trees, compared as ort compares them. The same merge now takes 13.6 s in all; the rest is rewriting every tree and reading all three sides in full (an open thread) |
| `path~<branch>` naming was never exercised: branch names were commit ids and paths came from a–d | Branches are refs (`o<i>`, `t/<i>`, so `/` becomes `_`), and T1c's paths collide with those names |
| Trees too small for the redo; no unrelated histories | T1d; T1e |

### Mutation check (X13b)

| # | Mutant | Result |
|---|---|---|
| K1 | Ours' mode ignored when ours kept the base's mode | killed (T1, T1b) |
| K2 | A conflict of three modes counted clean | survived the random corpora; T4 added, now killed |
| K3 | Two-way content merge only without a base (not when the base has another type) | survived the random corpora; killed by T4 |
| K4 | Conflicting symlinks counted clean | killed (T1, T1b) |
| K5 | Distinct types: theirs renamed even when ours is the regular file | equivalent: in that branch the types differ, so both conditions agree |
| K6 | Distinct types: the base always kept at stage 1 | killed (T1, T1b) |
| K7 | File/directory: the other branch's name | killed (T1, T1b) |
| K8 | No trivial directory merges | killed (T1, T1b) |
| K9 | Trivial directory merges even when a deletion on that side is a relevant source | killed (T1, T1b) |
| K10 | No directory-rename relevance (0x07) | killed (T1b only) |
| K11 | A moved file the merge deletes counted as a conflict | killed (T1, T1b) |
| K12 | Messages left in processing order | killed (T1, T1b) |
| K13 | A cleanly merged moved file keeping both sides' stages | unreachable: a moved file is on one side only, so the branch was removed |
| K14 | No redo after renames | killed (T1d, T5) |
| K15 | `unique_path` ignores directories the merge drops | killed (T1c, T5) |
| K16 | UTF-16 order for conflicts and messages | killed (T5) |
| K17 | Modes not made canonical | killed (T5) |
| K18 | The redo without the condition that rename detection runs | equivalent: walking a deferred directory needs a relevant source on its side, so the condition was redundant; removed |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/xdiff.ts` | **Adopt** | git's diff, exactly: the base of merge (X13), blame and status later |
| `src/xmerge.ts` | **Adopt** | git's content merge, exactly |
| `src/merge-trees.ts` | **Adopt** (renames still to come, X13d) | ort's tree merge without renames, exactly; the base for X13d |

## Open threads

1. **Submodules** in the tree merge (gitlinks: `merge_submodule`'s fast-forward rules).
2. **X13c and later**: rename detection (`diffcore-rename`'s exact and similarity detection),
   ort's rename conflicts, directory renames, and criss-cross merges (ort's recursive virtual base).
3. **Large trees**: the tree merge reads all three trees in full and writes every tree of the
   result, so 20k files take seconds where git takes milliseconds. git keeps the ids of subtrees it
   resolved whole; doing the same would make the cost follow the size of the change.
4. **Styles and options**: diff3 and zdiff3, `-Xours`/`-Xtheirs`/union, whitespace flags, the
   patience diff, the indent heuristic (for `diff` output).
5. **Performance**: classes are keyed by latin-1 strings, where a hash with byte comparison (as git
   does) would avoid the copies; histogram allocates its tables on every call (typed arrays, reused,
   would close most of its 5× gap to C on its quadratic case).
