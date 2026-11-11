# 33 — Can merge-ort's recursive merges (criss-cross histories) be reproduced exactly?

Plan id **X13** (single diff and merge engine), slice **X13f: criss-cross merges**. Status: **open**.

## Question

When two branches have more than one best common ancestor, merge-ort first merges the ancestors
into a virtual merge base (`merge_ort_internal`), and repeats when those have several bases of
their own. The result depends on:
- **Which ancestors there are, and their order.** This is `get_merge_bases`:
  `paint_down_to_common` walks by commit date, `remove_redundant` drops ancestors of other
  candidates, the result is ordered by date, and merge-tree reverses it.
- **How the inner merges differ.** At `call_depth` > 0:
  - the branches are "Temporary merge branch 1" and "2";
  - conflict markers are longer by 2 per level;
  - binary files, symlinks, distinct types and modify/delete keep the base's version (a virtual
    ancestor);
  - nothing is reported, and directory renames are not detected.

The virtual base's conflicted blobs, markers included, become the outer merge's base.

Can the X13d/X13e port, given commits rather than trees, match `git merge-tree --write-tree` on
criss-cross histories?

## Reject condition

Rejected if, on any case of the corpus, the tree id, a conflicted entry or a message differs from
`git merge-tree --write-tree` on the same two commits, or a merge is clean here and conflicted there.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| C1 | `mergeBases(repo, a, b)` equals `git merge-base --all a b` (as a set, and in git's order) on 500 random DAGs with criss-crosses, equal and distinct commit dates, and unrelated roots. |
| C2 | Hand-made criss-cross merges, equal to git: a clean recursive merge; a conflict in the virtual base (nested markers in the outer merge); a binary conflict, a symlink conflict and a modify/delete in the ancestors (the base's version kept); three merge bases (two levels of virtual commits); renames in the ancestors. |
| C3 | 500 random histories with two or more merge bases, merged with `git merge-tree`. Equal tree ids, conflicted entries and messages. |
| C4 | X13d and X13e's suites still pass (single merge base). |
| C5 | Portable: `src/` has no `node:` imports. |

## Scope

- Out of scope: octopus merges, commit-graph generation numbers (the commits are walked by date,
  as git does without a commit-graph), and `-X` options.
