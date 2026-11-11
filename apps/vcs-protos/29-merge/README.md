# 29 — Can one diff and merge engine produce git merge-tree's trees, conflicts and markers?

Plan id **X13** (single diff and merge engine), slice **X13a: git's content merge, byte for
byte**. Status: **answered — yes: a port of git's xdiff matches `git merge-tree` byte for byte on every case**.

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

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/xdiff.ts` | **Adopt** | git's diff, exactly: the base of merge (X13), blame and status later |
| `src/xmerge.ts` | **Adopt** | git's content merge, exactly |

## Open threads

1. **X13b, the tree merge**: ort's conflict kinds (modify/delete, add/add, directory/file, modes,
   submodules), the merged tree with its conflicted blobs, and the conflict messages of
   `merge-tree`.
2. **X13c**: renames (`diffcore-rename`'s exact and similarity detection), directory renames, and
   criss-cross merges (ort's recursive virtual base).
3. **Styles and options**: diff3 and zdiff3, `-Xours`/`-Xtheirs`/union, whitespace flags, the
   patience diff, the indent heuristic (for `diff` output).
4. **Performance**: classes are keyed by latin-1 strings, where a hash with byte comparison (as git
   does) would avoid the copies; histogram allocates its tables on every call (typed arrays, reused,
   would close most of its 5× gap to C on its quadratic case).
