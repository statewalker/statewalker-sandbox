# 33 — Can merge-ort's recursive merges (criss-cross histories) be reproduced exactly?

Plan id **X13** (single diff and merge engine), slice **X13f: criss-cross merges**. Status: **answered — yes: git's merge bases and merge-ort's recursive merge match git on 511
histories, more than 200 of them with several merge bases**.

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
| C2+ | Three criss-cross cases added after the mutation check: distinct types, a directory rename, and a conflicting rename/rename (1to2), each in the ancestors. |

## Scope

- Out of scope: octopus merges, commit-graph generation numbers (the commits are walked by date,
  as git does without a commit-graph), and `-X` options.

## Answer

Yes. `src/recursive.ts` (about 220 lines, no `node:` imports) and the inner-merge rules in
`31-ort/src/ort.ts` match git on every case:
- **C1:** `git merge-base --all` gives the same list in the same order on 511 histories, both with
  distinct commit dates and all equal.
- **C2:** 11 hand-made criss-cross merges give `git merge-tree --write-tree`'s tree ids, conflicted
  entries and messages.
- **C3:** 500 random histories do the same. More than 200 of them have several merge bases.
- **C4:** X13b–X13e's suites still pass.

**Merge bases** (`get_merge_bases`, commit-reach.c, without a commit-graph):
- `paint_down_to_common` walks a queue ordered by commit date, newest first, with ties going to the
  earlier insertion. It stops when only stale commits are left.
- A commit reached from both sides is a candidate, kept in date order (`commit_list_insert_by_date`
  places a commit before the first strictly older one).
- `remove_redundant` drops a candidate that another candidate reaches.
- merge-tree reverses the list.

**`merge_ort_internal`:**
- The first base is popped, and each next base is merged with it one level deeper, under the
  branches "Temporary merge branch 1" and "2".
- The result is a virtual commit (date 0) whose parents are the two merged bases. Later merge-base
  walks go through it.
- With no base, the virtual base is the empty tree.

**Inner merges** (`call_depth` > 0):
- nothing is reported;
- markers are 7 + 2 × depth long (8 + 2 × depth for rename/rename and rename collisions);
- binary content keeps the base cleanly (`virtual_ancestor`);
- a symlink conflict, distinct types and modify/delete all keep the base's version;
- directory renames are not detected.

The virtual base's conflicted blobs, markers included, are the outer merge's base. C2's "a conflict
in the virtual base" shows the nested markers.

### Mutation check

| # | Mutant | Result |
|---|---|---|
| F1 | Merge bases not reversed | killed (C2, C3) |
| F2 | Other names for the temporary branches | killed (C2, C3) |
| F3 | Inner markers not longer | killed (C2, C3) |
| F4 | Inner binary merges conflict | killed (C2) |
| F5 | Inner symlink conflicts keep ours | killed (C2) |
| F6 | Inner modify/delete keeps the modification | killed (C2, C3) |
| F7 | Inner distinct types moved aside | survived; killed by a C2 case added afterwards |
| F9 | No `remove_redundant` | killed (C1) |
| F10 | Equal dates inserted first | killed (C1, C2, C3) |
| F11 | Queue ties to the newest insertion | killed (C1, C2) |
| F12 | Directory renames in inner merges | survived; killed by a C2 case added afterwards |
| F13 | Inner rename markers not longer | survived; killed by a C2 case added afterwards |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/recursive.ts` | **Adopt** | git's merge bases and merge-ort's recursive merge, exactly |

## Open threads

1. Commit-graph generation numbers (`compare_commits_by_gen_then_commit_date`,
   `remove_redundant_with_gen`). Results are the same, but walks are faster on big histories.
2. Octopus merges; `-X` options; submodules.
3. **Performance**: the queue is a linear scan, while git uses a heap. The walk is O(n²) on long
   histories.
