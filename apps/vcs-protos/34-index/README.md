# 34 — Can a portable index and working tree interoperate with git, fast?

Plan id **X14** (index & working tree on files-sync). Status: **open**.

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
| W3 | 300 random working-tree changes (edits, deletions, new files, mode flips, symlinks, files becoming directories) over a committed tree: our status equals `git status --porcelain=v1 --untracked-files=all --no-renames`, for staged and unstaged changes. |
| W4 | A 50,000-file working tree: after one status (which refreshes the stat data), a second status hashes 0 files. One edited file is hashed alone. This holds on the in-memory FilesApi and on Node. |
| W5 | Racy git: an edit that keeps a file's size and leaves its mtime at or after the index's timestamp is reported changed, by us and by git, whichever wrote the index. Entries that are racy when the index is written are smudged, as git does (size 0). |
| W6 | Portable: `src/` has no `node:` imports outside a Node `lstat` adapter. |

## Scope

- Out of scope: `.gitignore` (the corpus has no ignore files; untracked means not in the index),
  split index, sparse-checkout's sparse directories, fsmonitor, the untracked cache (UNTR is kept
  as is), submodules, and `core.autocrlf` or other filters.
