# 35 — Can git and webrun-vcs finish each other's merges, cherry-picks and rebases?

Plan id **X15** (sequencer & git op-state). Status: **answered — yes: on 120 random histories our merge, cherry-pick and rebase leave the same state files, index and working tree as git; native git finishes ours and we finish git's, with the same commit ids; and a rebase resumes from files alone after a reload**.

## Question

A merge, cherry-pick or rebase that stops on a conflict leaves its state in `.git`: `MERGE_HEAD`,
`MERGE_MSG`, `CHERRY_PICK_HEAD`, `ORIG_HEAD`, `AUTO_MERGE`, the `rebase-merge/` directory, and an
index with conflict stages. If webrun-vcs writes and reads exactly that state, then:
- the user can start an operation in the browser and finish it with native `git commit` or
  `git rebase --continue` (and the other way round);
- an operation survives a page reload or a Durable Object's recreation, because nothing lives in
  memory between steps.

## Reject condition

Rejected if, on any case below, a state file, an index entry, a working-tree file or a resulting
commit id differs from what native git produces in a twin repository with the same dates and
identities.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| S1 | **Merge.** Our `merge` of a branch, on random and hand-made histories: when clean, the same merge commit (or fast-forward) as `git merge`; when conflicted, the same `MERGE_HEAD`, `MERGE_MSG` (`Merge branch 'x'`, ` into y` except on main/master, `# Conflicts:`), `MERGE_MODE`, `ORIG_HEAD`, `AUTO_MERGE`, `git ls-files --stage` and working-tree files. |
| S2 | **Native finishes ours.** After our conflicted merge, `git add -A && git commit --no-edit` gives the commit native git gives in the twin. `git merge --abort` restores HEAD, index and files. |
| S3 | **We finish native.** After a conflicted `git merge` and a resolution, our `commitOp` gives the commit `git commit --no-edit` gives, and removes the state files. Our `abortOp` equals `git merge --abort`. |
| S4 | **Cherry-pick.** As S1–S3 for `git cherry-pick <commit>`: `CHERRY_PICK_HEAD`, `MERGE_MSG` with the commit's message, and the original author kept on commit. |
| S5 | **Rebase** (`git rebase <upstream>`, merge backend, linear branch). Clean: the same commits as git, unchanged picks fast-forwarded, commits that become empty dropped. Stopped: the same `rebase-merge/` files git reads (`head-name`, `onto`, `orig-head`, `git-rebase-todo`, `done`, `msgnum`, `end`, `author-script`, `message`, `stopped-sha`, `interactive`, `drop_redundant_commits`, `no-reschedule-failed-exec`), `REBASE_HEAD`, `MERGE_MSG`, index and files. Native `git rebase --continue` finishes ours, and our `continueOp` finishes native's, with the same final commits. `--abort` both ways restores the branch. |
| S6 | **Resume.** The S5 flow on an in-memory FilesApi: each step runs on a freshly opened repository over the same files (a reload), with the same final commit ids as git. |
| S7 | **Portable.** `src/` has no `node:` imports. |
| S9 | Added after review: untracked files a merge, cherry-pick or rebase would overwrite are refused as git refuses them, with the same state left; a branch with merge commits is refused; merge messages for a remote-tracking branch, a commit id, a lightweight tag, a detached HEAD and a short name; messages without a final newline or with CRLF (conflict list, `rebase-merge/message`, todo subjects); `rewritten-list`; X5's ref contract on `filesRefFiles`, directly and through `subFiles`. |
| S8 | Added after the mutation check: a rebased commit that becomes empty is dropped; a directory a merge empties is removed; files a merge does not change are not rewritten and keep their index stat data. (The corpus also got side commits with their own author and date.) |

## Scope

- Tracked files must be unchanged before an operation starts. git refuses only the local changes
  the operation would overwrite; we refuse any (stricter). Untracked files the operation would
  overwrite are refused, as git refuses them (`verify_absent`).
- Rebase of a linear branch: a branch with merge commits is refused (git replays the merged-in
  commits too, in `rev-list --topo-order` order; not ported). Annotated tags are not merged.
- File modes follow the index with `core.fileMode=false` and `core.symlinks=false`: a symlink is
  written as a file holding its target, and no executable bit is set.
- `rebase-merge/patch` and `git-rebase-todo.backup` (shown to the user, not read back) are not
  written.
- Matching git 2.43 and newer: X13's merge probes, plus two new ones. `legacyAutoMerge`: merge-ort
  writes `AUTO_MERGE` after every merge that updates the worktree, so a clean cherry-pick or rebase
  leaves it behind. `legacyRebaseHead`: git removes `REBASE_HEAD` before each pick, so a rebase
  that stopped on its last pick leaves it behind (2.43 and, by its source, 2.56; the probe
  decides). `legacyTodoFormat` and
  `legacyRebaseMessage` (found by CI on git 2.56): git 2.43 writes todo lines as
  `pick <id> <subject>` and `rebase-merge/message` as the message and a newline; 2.56 writes
  `pick <id> # <subject>` and the message with its conflict list.
- Out of scope: `--rebase-merges`, interactive todo editing, `--onto`, autostash, dropping commits
  already upstream by patch id (the corpus has none), octopus merges, `rerere`, hooks, signing.

## Answer

Yes. `src/sequencer.ts` (about 620 lines) and `src/files-adapters.ts` (a FilesApi seen from a
subdirectory, and X5's `RefFiles` over any FilesApi, about 100 lines) implement it on X13's merges
and X14's index. All 17 tests pass:

- **S1, merge.** 120 random histories (clean merges and conflicts) and three hand-made cases
  (fast-forward, already up to date, a merge into another branch): every state file, index entry,
  working-tree file, ref and `git status` line equals git's.
- **S2 and S3, merge both ways.** Native `git commit --no-edit` finishes our conflicted merges, and
  our `commitOp` finishes git's (after git's add or ours), with the same commit ids. Our
  `abortOp` and `git merge --abort` give the same result from either side's state.
- **S4, cherry-pick.** The same, on 120 histories: `CHERRY_PICK_HEAD`, `MERGE_MSG`, the original
  author on commit, finished by either side.
- **S5, rebase.** 120 histories, each started by git or by us and continued by git or by us in turn;
  every stop and every continue compared. `--abort` both ways.
- **S6, resume.** Rebases on an in-memory FilesApi, each step on a freshly opened repository: the
  same final commits as git.
- **S8.** Empty picks dropped, emptied directories removed, unchanged files left alone.
- **S9, review cases.** Untracked files, branches with merges, merge message wording, messages
  without a final newline, `rewritten-list`, and X5's ref contract on `filesRefFiles`.

**What git keeps, and we write the same way:**
- **Merge** (builtin/merge.c): `ORIG_HEAD` always (also when already up to date); on a conflict
  `MERGE_HEAD`, `MERGE_MODE` (empty), `MERGE_MSG` (fmt-merge-msg's title: `Merge branch 'x'`,
  `remote-tracking branch`, `tag` or `commit '<id>'`, with ` into y` unless y is main or master,
  ` into HEAD` when detached; then `# Conflicts:` and each conflicted path once) and `AUTO_MERGE` (the merged
  tree with markers). The index has the conflict stages, the working tree the merged files.
- **Cherry-pick** (sequencer.c `do_pick_commit`): `CHERRY_PICK_HEAD`, `MERGE_MSG` (the commit's
  message as it is, then the conflict list: no blank line when the message lacks a final newline), `AUTO_MERGE`; markers labelled `HEAD` and `<abbrev> (<subject>)`.
  No `ORIG_HEAD`.
- **Committing** (`git commit --no-edit`): the message is `MERGE_MSG` with whitespace cleaned and
  comments kept; a merge has both parents, a cherry-pick keeps the picked commit's author and
  refuses an empty result. `rebase --continue` runs the editor, so its cleanup strips comments.
- **Rebase** (merge backend): `rebase-merge/` holds `head-name`, `onto`, `orig-head`, the todo list
  and `done` (`pick <id> <subject>`), `msgnum`, `end`, and three empty marker files. A stop adds
  `author-script` (shell-quoted, `@<seconds> <tz>` date), `message` (the message and a blank line),
  `stopped-sha`, `REBASE_HEAD`, `MERGE_MSG` and `AUTO_MERGE`; each committed pick adds
  `<old> <new>` to `rewritten-list`. A pick whose parent is HEAD is
  fast-forwarded; a pick that becomes empty is dropped. `REBASE_HEAD` goes with the next pick, so a
  rebase that stopped on its last pick leaves it behind, as git does.
- **Abort**: a reset to HEAD (merge) or to `orig-head` with HEAD reattached (rebase); files the
  index held beyond the target are removed.

**Resume.** No step keeps anything in memory: each reads HEAD, the index and the state files, so a
page reload or a Durable Object's recreation continues where the files say. On a FilesApi, refs use
`filesRefFiles`, whose changes go through one queue per instance (exclusive within a process;
X2's adapters where several processes or tabs race).

### Mutation check

| # | Mutant | Result |
|---|---|---|
| Q1 | ` into <branch>` on every branch | killed (S1) |
| Q2 | No conflict list in `MERGE_MSG` | killed (S1) |
| Q3 | Conflict list with a line per stage | killed (S1); the first run's mutant did not compile and was redone |
| Q4 | No `ORIG_HEAD` when already up to date | killed (S1) |
| Q5 | No fast-forward merge | killed (S1) |
| Q6 | Abort keeps files the index held beyond HEAD | killed (S3) |
| Q7 | Cherry-pick committed with our author | survived (every commit had one author); killed once side's commits got their own (S4) |
| Q8 | Comments kept on `rebase --continue` | killed (S5) |
| Q9 | Rebase picks never fast-forward / empty picks kept | the fast-forward is unreachable in `git rebase <upstream>` and was removed; keeping empty picks is killed by S8 |
| Q10 | `REBASE_HEAD` kept across picks | killed (S5) |
| Q11 | `rebase-merge/message` without its blank line | killed (S5) |
| Q12 | `msgnum` from the todo instead of `done` | killed (S5) |
| Q13 | No `AUTO_MERGE` after a clean pick (git 2.43) | killed (S4) |
| Q14 | Abort leaves HEAD detached | killed (S5) |
| Q15 | Emptied directories left behind | survived (snapshots ignored empty directories); killed by S8 |
| Q16 | Unchanged files rewritten, stat data lost | survived (invisible to git); killed by S8 |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/sequencer.ts` | **Adopt** (`--onto`, `--rebase-merges`, patch-id skipping to come) | git's op-state written and read, both ways |
| `src/files-adapters.ts` | **Adopt** for one writer | a whole repository in one FilesApi |

## Open threads

1. `git rebase --onto`, `--rebase-merges`, interactive todo editing, and skipping commits already
   upstream by patch id (`git rev-list --cherry-pick`).
2. `cherry-pick` and `revert` of ranges (`.git/sequencer/`), and `revert`.
3. Reflog messages as git writes them (`rebase (pick): …`, `merge side: Merge made by …`).
4. Checking only the paths an operation touches for local changes (git's rule), instead of
   refusing any change.
5. Rebasing branches with merges (`rev-list --topo-order --no-merges`), merging annotated tags
   (fmt-merge-msg's tag message), symlinks and executable bits where the platform has them.

### Review

| Finding | Fix |
|---|---|
| Untracked files overwritten (a fast-forward, a cherry-pick, a rebase's checkout) | refused before anything changes, as `verify_absent` (S9) |
| Rebase of a branch with merges silently lost the merged-in commits | refused (S9); porting git's topo order is an open thread |
| `MERGE_MSG` wording for remote-tracking branches, commit ids, tags, detached HEAD; short names unresolved | fmt-merge-msg's titles, dwim-style resolution; annotated tags refused (S9) |
| A blank line too many before `# Conflicts:` for messages without a final newline | the list appended to the message as it is; `rebase-merge/message` and todo subjects likewise (S9) |
| `filesRefFiles` lost updates under concurrent batches in one process | one queue per instance; X5's contract passes (S9) |
| git 2.56 removes `REBASE_HEAD` once per run, not per pick | `legacyRebaseHead` probe (S5 runs with it) |
| `rewritten-list` not written | written (compared in S5) |
| Modes, `patch`, `git-rebase-todo.backup`; tracked-file check stricter than git | documented in the scope |
