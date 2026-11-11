# 34 — Can a portable index and working tree interoperate with git, fast?

Plan id **X14** (index & working tree on files-sync). Status: **answered — yes: our index round-trips git's byte for byte, git reads ours clean, status equals
git's on 300 random changes, and 50,000 unchanged files hash nothing**.

## Question

webrun-vcs needs git's staging area: the index (`.git/index`) and a working tree on any FilesApi
(OPFS, Node, SQLite, memory). Three properties matter:
- **Interop.** Native git must accept an index we write: `git status` clean, `git write-tree` the
  same tree. We must read the index git writes, mid-operation, in each version (2, 3, 4) and with
  each extension.
- **Speed.** A status over 50,000 unchanged files must hash nothing. The stat data cached in the
  index decides which files are unchanged.
- **Safety.** A file changed within the index's own timestamp granularity is "racily clean". It
  must still be found changed (git's racy-git rules: `is_racy_timestamp`, and smudging racy
  entries on write).

FilesApi reports only a size and a millisecond `lastModified`. Node can give the full `lstat`. The
index must work with either, and record what it has in the fields git reads.

## Reject condition

Rejected if, on any case below, our index or status disagrees with git's: a byte of the index
round trip, an entry, a status line, or a racily changed file reported clean. Rejected too if an
unchanged 50,000-file tree hashes any file on a second status.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| W1 | Index files written by git, read and written back byte for byte: versions 2, 3 (intent-to-add, skip-worktree) and 4 (prefix compression); conflict stages 1–3 after a failed merge; the TREE, REUC, EOIE and IEOT extensions. Unknown optional extensions are kept. |
| W2 | Our staging of a working tree (`add`) writes an index for which `git status --porcelain` is clean, `git ls-files --stage` is identical, and `git write-tree` gives our tree. |
| W3 | 300 random working-tree changes over a committed tree, with `core.fileMode=false`: edits, deletions, new files, files becoming directories and back, staged and unstaged. Our status equals `git status --porcelain=v1 --untracked-files=all --no-renames`. |
| W4 | A 50,000-file working tree: after one status (which refreshes the stat data), a second status hashes 0 files. One edited file is hashed alone. This holds on the in-memory FilesApi and on Node. |
| W5 | Racy git: an edit that keeps a file's size and leaves its mtime at or after the index's timestamp is reported changed, by us and by git, whichever wrote the index. Entries that are racy when the index is written are smudged, as git does (size 0). |
| W6 | Portable: `src/` has no `node:` imports outside a Node `lstat` adapter. |
| W7 | Added after the mutation check, one case each: names of every padding length and past version 4's one-byte varint; a racy edit where the stat data still matches; a size change with the mtime kept; a same-size edit on the in-memory FilesApi; a touched file refreshed; intent-to-add and skip-worktree against `git status`; and a same-size edit with the mtime restored, where only ctime differs. |

## Scope

- FilesApi has no symlinks and no executable bit. The working tree's modes are taken from the index,
  as git does with `core.fileMode=false` and `core.symlinks=false`.
- Out of scope: `.gitignore` (the corpus has no ignore files; untracked means not in the index),
  split index, sparse-checkout's sparse directories, fsmonitor, the untracked cache (UNTR is kept
  as is), submodules, and `core.autocrlf` or other filters.

## Answer

Yes, for the index and status. Two files implement it, `src/index-file.ts` and `src/worktree.ts`,
about 450 lines together, plus a 30-line Node `lstat` adapter. All 19 tests pass:

- **W1, the index format.** Git's index files read and write back byte for byte:
  - versions 2, 3 and 4;
  - intent-to-add and skip-worktree;
  - conflict stages;
  - the TREE, REUC, EOIE and IEOT extensions;
  - names of every padding length, and long shared prefixes.
- **W2, staging.** After our `add`, `git status` shows exactly the staged changes, and
  `git ls-files --stage` equals ours.
- **W3, status.** Our status equals `git status --porcelain` on 300 random working-tree changes,
  staged and unstaged.
- **W4, no hashing.** A second status over 50,000 files in memory hashes nothing, and an edit
  hashes one file. On Node, 2,000 committed files hash nothing.
- **W5 and W7, racy git.** Racy git holds whichever side wrote the index, and racy entries are
  smudged when we write.

**The index** (`read-cache.c`):
- Entries are their stat data, the object id and flags; version 3 adds extended flags.
- Versions 2 and 3 pad each entry with 1–8 NULs. Version 4 prefix-compresses names with git's offset
  varint.
- Extensions are kept as signature and data, followed by the SHA-1 trailer.
- `addAll` starts the index afresh with no extensions: TREE would be stale.

**Deciding what to hash** (`ie_match_stat`):
- A file is read when its stat data no longer matches, or when it is racy: its mtime is not older
  than the index file itself (`is_racy_timestamp`).
- It is also read when the entry was smudged, that is, recorded with size 0 for a non-empty blob.
- A FilesApi gives a size and a millisecond mtime, which are compared at that precision.
- Node's `lstat` gives git's full set: ctime and mtime with nanoseconds, dev, ino, uid and gid.
- Content that turns out unchanged refreshes the entry, so the next status skips the file.
- `addAll` smudges entries that are racy against the index being written
  (`ce_smudge_racily_clean_entry`).

**Status codes:**
- Index against HEAD: A, M or D.
- Working tree against the index: M or D. Intent-to-add shows as ` A`, and skip-worktree entries
  are not checked.
- Unmerged paths get their codes from the stages present (UU, AA, DU and so on).
- Untracked files are `??`.
- Modes come from the index, as with `core.fileMode=false`, since FilesApi has no executable bit.

**Stricter than this git.** With full `lstat`, we compare nanoseconds. Ubuntu's git 2.43 is built
without `USE_NSEC` and compares seconds, so it misses a same-size edit whose mtime was restored
within the same second of ctime. We report it (W7). Finding more changes than git is the safe
direction.

### Mutation check

| # | Mutant | Result |
|---|---|---|
| I1 | Version 4 varint without the +1 | survived W1's short names; killed by the long names added (W1) |
| I2 | Padding one byte short | survived; killed by the names of every length (W1) |
| I3 | Extended flags written in version 2 | equivalent: git writes version 3 whenever an entry has extended flags, and `addAll` writes none |
| I4 | No racy check | killed (W5, W7) |
| I5 | Smudged entries trusted | equivalent: a smudged entry's size 0 never matches a non-empty file, so the size comparison already reads it |
| I6 | Size not compared | equivalent on these stat sources: every write changes ctime (Node) or `lastModified` (FilesApi) |
| I7 | Milliseconds not compared (FilesApi) | killed by W7's same-size edit in memory |
| I8 | Racy entries not smudged on write | killed (W5) |
| I9 | Stat data not refreshed | killed by W7's touched file |
| I10 | Deletions from the index not reported | killed (W3) |
| I11 | No untracked files | killed (W3) |
| I12 | Intent-to-add shown as unchanged | killed (W7) |
| I13 | Skip-worktree entries checked | killed (W7) |
| I14 | ctime not compared (full stat) | killed by W7's restored-mtime edit |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/index-file.ts` | **Adopt** | git's index, byte for byte, in every version |
| `src/worktree.ts` | **Adopt** (checkout and `.gitignore` to come) | status and staging with git's stat and racy rules |

## Open threads

1. `.gitignore` (wildmatch, negation, directory rules) and the untracked cache.
2. Checkout: writing the working tree from a tree, plus updating the index and TREE extension
   (cache-tree) so a commit needs no tree rewrite.
3. Rename detection in status (`--no-renames` is assumed here).
4. Performance: `scan` lists the whole tree. fsmonitor or files-sync events could limit it to
   changed directories.
