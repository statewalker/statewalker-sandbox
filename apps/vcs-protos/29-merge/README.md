# 29 — Can one diff and merge engine produce git merge-tree's trees, conflicts and markers?

Plan id **X13** (single diff and merge engine), slice **X13a: git's content merge, byte for
byte**. Status: **open**.

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

Can a TypeScript port of git's xdiff produce, for any three versions of a file, the bytes and the
clean/conflicted result that `git merge-tree` writes?

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
| M6c | The classic algorithm's heuristics: inputs whose edit cost passes the cost limit, and one of about 35,000 lines a side, where the limit exceeds 256 and the snake heuristic runs. |
| M7 | Portable: no `node:` imports; one module for diff (`xdiff.ts`) and one for merge (`xmerge.ts`). |

## Scope

- The diff3 and zdiff3 styles, `-Xours`/`-Xtheirs`/union, whitespace flags, `merge.conflictstyle`:
  git's defaults only. Patience diff and the indent heuristic (merge-ort sets neither) are out.
