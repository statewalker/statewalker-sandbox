# 32 — Can merge-ort's directory renames be reproduced exactly?

Plan id **X13** (single diff and merge engine), slice **X13e: directory renames**. Status: **answered — yes: X13d's port with directory renames matches `git merge-tree` on 1,011
directory-rename merges, and on all of X13d's 3,328**.

## Question

When one side of a merge removes a directory and renames most of its files into another directory,
merge-ort infers a directory rename. Files the other side added to the old directory, or renamed into
it, belong in the new one. merge-tree's default (`merge.directoryRenames=conflict`) moves them there
and reports "CONFLICT (file location)".

The inference is spread over two files:
- **diffcore-rename** counts where each removed directory's files went (`dir_rename_count`). The
  counts drive basename guesses for files whose basenames are not unique (`idx_possible_rename`).
  Sources that are relevant only for their location are dropped once the majority is already clear
  (`handle_early_known_dir_renames`).
- **merge-ort** turns the counts into one destination per directory
  (`get_provisional_directory_renames`, which reports "directory rename split" when there is no
  majority). It then drops directories both sides renamed and applies the result to each added or
  renamed path (`check_for_directory_rename`, `apply_directory_rename_modifications`). Paths that
  would land in one place, or in an existing path's way, are reported as "implicit dir rename". A
  renamed directory that was itself renamed again is skipped with a warning.

Can X13d's port, extended with all of this, match `git merge-tree` when directories disappear?

## Reject condition

Rejected if, on any case of the corpus, the tree id, a conflicted entry or a message differs from
`git merge-tree --write-tree`, or a merge is clean here and conflicted there.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| E1 | X13d's tests (O1–O6, 3,328 merges) still pass on the extended port. |
| E2 | Hand-made cases equal to git: a directory renamed with a file added on the other side; a file renamed into the old directory; a split with no majority; two paths mapped to one place; an existing path in the way; a renamed directory renamed again (the warning); a directory renamed by both sides; a rename into itself after a directory rename; nested directories; a basename guess (non-unique basenames resolved by the directory's majority). |
| E3 | 1,000 random merges where whole directories are renamed, split or emptied on one side, while the other side adds, edits, renames and deletes inside them. Equal to git. |
| E4 | The corpus reaches every directory-rename message: file location, directory rename split, implicit dir rename (both kinds) and the re-rename warning. |
| E5 | Portable: `src/` has no `node:` imports. |
| E2+ | Two cases added after the mutation check: a basename guess against a closer candidate, and a base file where a directory rename would put a path (newer git's `path_in_way`). |

## Scope

- Out of scope: `merge.directoryRenames=true` (moving paths without the conflict), criss-cross
  merges (the next slice), and remembering renames across a rebase (cached pairs between merges).

## Answer

Yes. Directory renames live in `31-ort/src/ort.ts` and `30-renames/src/renames.ts`, together about 450
lines, with no `node:` imports. With them, the port matches `git merge-tree --write-tree` on every
case:
- E2: 11 hand-made cases;
- E3: 1,000 random merges where directories are renamed, split, emptied, renamed by both sides, or
  renamed into a directory the other side renames away;
- E1: X13d's suites (O1–O6, 3,328 merges) still pass.

In E3, git reported:

| Message | Count |
|---|---|
| file location | 104 |
| directory rename split | 12 |
| implicit dir rename | 3 |
| re-rename warning | 6 |
| rename/rename | 118 |
| rename/delete | 146 |

**diffcore-rename** (`renames.ts`):
- **`dir_rename_count`.** Each rename counts its old directory → new directory. Parent directories
  are counted while the removed names stay the same, but only for directories merge-ort says were
  removed (`dirs_removed`).
- **`idx_possible_rename`.** A basename that is not unique among sources or destinations is tried
  at the destination its directory most often went to: the first highest count, in git's hashmap
  order.
- **`handle_early_known_dir_renames`.** The sources left unpaired count as an unknown destination.
  Once a directory's leader cannot be caught even if every unknown went elsewhere, its directory
  stops being relevant for itself, and sources relevant only for their location leave the search.
- **The counts kept for merge-ort.** Only removed directories keep their counts, and the unknowns
  are dropped.

**merge-ort** (`ort.ts`):
- **`dirs_removed`.** A directory gone from a side is recorded with its relevance: for ancestors
  inside a directory being renamed, or for itself when the other side added a file to it.
- **`get_provisional_directory_renames`.** Each removed directory goes to its unique majority
  destination. With no majority, git reports "directory rename split" and the merge is unclean.
- **`handle_directory_level_conflicts`.** A directory both sides renamed is renamed by neither.
- **`compute_collisions` and `check_for_directory_rename`.** Each path added or renamed into a
  directory the other side renamed is checked in turn:
  - several paths mapped to one place: "implicit dir rename";
  - an existing path in the way: "implicit dir rename";
  - a renamed directory the other side renamed again: the "WARNING: Avoiding applying" message.

  A path that cannot be placed leaves the merge unclean (`*clean_merge &= new_path != NULL`).
- **`apply_directory_rename_modifications`.** The entry moves under the new directory, creating the
  missing directory entries, and is a path conflict: "CONFLICT (file location)".

**Two git versions.** Newer git (2.56 checked) changed two rules, and the port follows newer git:
- **`path_in_way`.** A base file at the target is in the way unless it is the rename's own source.
  `legacyPathInWay` gives 2.43's rule, and the tests probe the installed git.
- **A rename into itself is skipped.** git 2.43 fails an assertion there, so E2b runs only where git
  does not crash.

### Mutation check

Each mutant ran against E2 and E3.

| # | Mutant | Result |
|---|---|---|
| X1 | No basename guesses (`idx_possible_rename`) | survived the corpora; killed by an E2 case added afterwards |
| X2 | No early culling (`handle_early_known_dir_renames`) | survived. Argued equivalent: it acts only when a directory's majority can no longer change, and a dropped location-only source would only have been paired as a plain rename that merges the same way |
| X3 | A split taken as a majority | killed (E2, E3) |
| X4 | A directory both sides renamed kept | survived. Reaching it needs both sides to hold the same removed directory as relevant, which only nested renames can make (one side renames the parent, the other the child); no corpus case does |
| X5 | The other side's collisions ignored | survived. It needs both sides to rename directories, with one side's path equal to the other side's collision target; not reached |
| X6 | No re-rename exclusion | killed (E2, E3) |
| X7 | No path-in-the-way check | killed (E2, E3) |
| X8 | `path_in_way` forced to 2.43's or to newer git's rule | newer git's rule is killed on 2.43 by an E2 case added afterwards; 2.43's rule is the legacy path and is killed on CI's git 2.56 |
| X9 | File location not a path conflict | killed (E2, E3) |
| X10 | `dirs_removed` never relevant for ancestors | killed (E3) |
| X11 | No relevant-for-self upgrade | killed (E2, E3) |
| X12 | Unplaced paths leave the merge clean | killed (E2, E3) |
| X14 | Ancestors never counted | killed (E3) |
| X15 | Unknown destinations kept in the counts | killed (E3, E4) |
| X16 | Counts for directories that were not removed | survived. Such counts are dropped before merge-ort reads them; they could only change a basename guess for a directory that was not removed |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `31-ort/src/ort.ts` | **Adopt** (criss-cross merges still to come) | merge-ort with renames and directory renames, exactly |
| `30-renames/src/renames.ts` | **Adopt** | git's rename detection, including merge-ort's directory-rename inputs |

## Open threads

1. **Criss-cross merges**: `merge_ort_internal`'s recursive virtual merge base, with `call_depth`
   markers and the inner merges' behaviour (`virtual_ancestor`, conflicts kept as base content).
2. `merge.directoryRenames=true` (paths moved without the conflict) and the "Path updated" messages.
3. X4 and X5's nested and two-sided directory renames, which no corpus case reaches yet.
