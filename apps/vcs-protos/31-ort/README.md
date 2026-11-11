# 31 — Can merge-ort's renames be reproduced exactly?

Plan id **X13** (single diff and merge engine), slice **X13d: ort's rename conflicts**. Status:
**open**.

## Question

X13b merges trees path by path. That is enough without renames, but a rename joins two paths into one
conflict entry. The entry carries a pathname per stage, `branch:path` conflict markers and a "path
conflict" flag, and it is resolved by `process_renames` before `process_entry`. X13c finds git's
rename pairs. Can a port that follows merge-ort's own structure produce `git merge-tree`'s trees,
conflicted entries and messages once renames are in play? The structure is:
- `collect_merge_info`: the tree walk, conflict_info per path, deferred directories and the redo;
- `detect_regular_renames`, restricted to ort's relevant sources;
- `collect_renames` and `process_renames`;
- `process_entries`: directories completed bottom-up, `process_entry`.

The rename cases are:
- a rename on one side with a modification on the other, merged at the new path with markers
  labelled `branch:path`;
- rename/delete;
- rename/rename, both to one path (1to1) and to two paths (1to2, 8-character markers);
- rename/add and rename/rename (2to1), where the rename collides with another path;
- a rename against a type change.

## Reject condition

Rejected if, on any case of the corpus, the tree id, a conflicted entry or a message differs from
`git merge-tree --write-tree`, or a merge is clean here and conflicted there.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| O1 | All of X13b's corpora pass on the port: T1–T1e, T4 and T5, 2,307 merges. |
| O2 | 1,000 random merges with renames on one or both sides. The renames may be exact, edited, or to a new directory. They are mixed with edits, deletions, additions at the old or new path, renames of the same file by both sides, and type changes. Directories never disappear, since each has a file neither side touches. The tree id, conflicted entries and messages are equal to git's. |
| O3 | Hand-made cases, one per rename case above, equal to git's, including the conflicted blobs with their `branch:path` labels and marker lengths. |
| O4 | The corpus reaches every rename case: git reports rename/delete, rename/rename, rename involved in collision, content conflicts at a renamed path, and clean renames. |
| O5 | Portable: `src/` has no `node:` imports. |

## Scope

- Directory renames (`dir_rename_count`, implicit renames into a renamed directory) and criss-cross
  merges are X13e. The corpus keeps every directory alive so that git finds no directory renames.
- Out of scope: submodules, the rename limit's warning, `-X` options, and remembering renames across
  a rebase (cached pairs).
