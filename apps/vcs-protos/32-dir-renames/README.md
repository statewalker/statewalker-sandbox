# 32 — Can merge-ort's directory renames be reproduced exactly?

Plan id **X13** (single diff and merge engine), slice **X13e: directory renames**. Status: **open**.

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

## Scope

- Out of scope: `merge.directoryRenames=true` (moving paths without the conflict), criss-cross
  merges (the next slice), and remembering renames across a rebase (cached pairs between merges).
