# 31 — Can merge-ort's renames be reproduced exactly?

Plan id **X13** (single diff and merge engine), slice **X13d: ort's rename conflicts**. Status:
**answered — yes: a port that follows merge-ort's own structure matches `git merge-tree` on 3,321
merges, 1,014 of them with renames**.

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
| O3 | Hand-made cases, one per rename case above, equal to git's, including the conflicted blobs with their `branch:path` labels and marker lengths. Two cases were added after the mutation check: an irrelevant source that must not take a destination from a relevant one, and a binary rename/rename (1to2). |
| O4 | The corpus reaches every rename case: git reports rename/delete, rename/rename, rename involved in collision, content conflicts at a renamed path, and clean renames. |
| O5 | Portable: `src/` has no `node:` imports. |

## Scope

- Directory renames (`dir_rename_count`, implicit renames into a renamed directory) and criss-cross
  merges are X13e. The corpus keeps every directory alive so that git finds no directory renames.
- Out of scope: submodules, the rename limit's warning, `-X` options, and remembering renames across
  a rebase (cached pairs).

## Answer

Yes. `src/ort.ts` (about 800 lines, no `node:` imports) follows merge-ort.c function by function.
It gives the same tree id, conflicted entries and messages as `git merge-tree --write-tree` on every
case:
- O1: all 2,307 of X13b's merges, now run with rename detection on;
- O2: 1,000 random merges with renames;
- O3: 14 hand-made cases: one per rename case, plus two added after the mutation check.

In O2, git reported:

| Message | Count |
|---|---|
| rename/rename | 95 |
| rename/delete | 102 |
| rename involved in collision | 18 |
| content | 52 |
| add/add | 167 |
| modify/delete | 199 |
| distinct types | 39 |

The tree ids cover the conflicted blobs too, including their `branch:path` labels and 8-character
markers.

The structure:
- **`collect_merge_info`** walks the three trees one directory at a time and records each path as
  merge-ort does:
  - a path is resolved early when all three sides match, or when the files on both sides match;
  - each deletion and addition becomes a rename pair;
  - a deletion is a relevant source when the other side changed the file too, or when it lies in a
    directory one side removed and the other added to;
  - directories one side left alone are deferred, then resolved whole unless rename detection could
    need a source deleted on that side;
  - when walking the deferred directories at least triples the paths, the redo detects renames,
    caches them, and collects again.
- **Rename detection** is X13c's `findRenames`, run per side over that side's pairs in walk order:
  - exact renames over every source;
  - the basename pass and the matrix only over relevant sources;
  - merge-ort's settings: no empty renames, limit 7,000.
- **`process_renames`**, over both sides' renames sorted by source path:
  - **rename/rename(1to1):** the base joins the target entry and the source is removed.
  - **rename/rename(1to2):** a content merge with 8-character markers, written to both targets;
    the source stays at stage 1, and all three paths are conflicts.
  - **rename/add and rename/rename(2to1):** the rename is merged into the colliding entry with
    8-character markers. A content conflict adds "rename involved in collision".
  - **rename/delete:** a path conflict. A later modify/delete message is suppressed when the content
    is unchanged.
  - **rename against a type change:** the source keeps the other side's type.
  - **an ordinary rename:** the base and the other side's version join the target entry, with their
    old path in `pathnames`, so the markers read `branch:path`.
- **`process_entries`** processes the paths in reverse `sort_dirs_next_to_their_children` order:
  - a directory's tree is written once its contents are done, and a directory that comes out empty
    disappears, which is what file/directory decisions read;
  - `process_entry` handles moving files out of a directory's way, distinct types, content merges,
    modify/delete, additions and deletions, and records every unclean entry as a conflict.

The X13b emulation (`29-merge/src/merge-trees.ts`) reached the same results path by path on its own
corpora. With renames it cannot: a rename joins two paths into one entry with a pathname per stage
and a path-conflict flag, which only ort's structure carries. This port supersedes it.

### Mutation check

Each mutant ran against the test groups that bear on it: the rename groups (O2, O3, T4) or the
collection groups (T1b, T1c, T1d, T4/T5).

| # | Mutant | Result |
|---|---|---|
| D1 | Rename detection over every source, not only relevant ones | survived the corpora; killed by an O3 case added afterwards |
| D2 | rename/rename(1to1) handled as 1to2 | killed (O2, O3) |
| D3 | 7-character markers for rename/rename and collisions | killed (O2, O3) |
| D4 | Markers without `branch:path` | killed (O2, O3) |
| D5 | No path conflict on rename/delete | killed (O2, O3) |
| D6 | A rename against a type change counted as a collision | killed (O2) |
| D7 | The rename source kept | killed (O2, O3) |
| D8 | A modify/delete message for an unmodified rename/delete | killed (O2, O3) |
| D9 | Renames in side order instead of by source path | killed (O2) |
| D10 | No redo after renames | killed (T1d, T5) |
| D11 | No trivial directory merges | killed (T1b, T1d, T5) |
| D12 | No `dir_rename_mask` 0x07 | killed (T1b) |
| D13 | A moved file that merges cleanly counts as clean | equivalent: a moved file is on one side only, so it never reaches the content merge |
| D14 | `unique_path` suffixes counted from 1 | killed (T1c, T5) |
| D15 | rename/rename(1to2) leaves the source unconflicted | killed (O2, O3) |
| D16 | Binary rename/rename: both targets get ours' bytes | survived the corpora; killed by an O3 case added afterwards |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/ort.ts` | **Adopt** (directory renames and criss-cross still to come, X13e) | merge-ort, exactly, renames included; supersedes 29's `merge-trees.ts` |

## Open threads

1. **X13e**: directory renames (`get_provisional_directory_renames`, implicit renames, the
   basename guesses of `idx_possible_rename` from removed directories) and criss-cross merges
   (`merge_ort_internal`'s recursive virtual base, with `call_depth` markers).
2. The order of `handle_deferred_entries`: git walks deferred directories in its hashmap's order. The
   port uses insertion order. This can only change the order of rename pairs when relevant sources
   lie inside deferred directories, and no corpus case has shown a difference.
3. Submodules, `-X` options, the rename limit's warning, and remembering renames across a rebase.
4. **Large trees**: the port reads only the directories it needs, as ort does. It still writes a tree
   object for every completed directory, which is correct but slower than git's in-memory
   `write_tree`.
