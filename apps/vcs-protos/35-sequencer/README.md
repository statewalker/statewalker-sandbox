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

## Scope

- The working tree must be clean before an operation starts (git refuses local changes that a
  merge would overwrite; we refuse any).
- Matching git 2.43 and newer: X13's merge probes, plus one new one (`legacyAutoMerge`): git 2.43's
  merge-ort writes `AUTO_MERGE` after every merge that updates the worktree, so a clean cherry-pick
  or rebase leaves it behind.
- Out of scope: `--rebase-merges`, interactive todo editing, `--onto`, autostash, dropping commits
  already upstream by patch id (the corpus has none), octopus merges, `rerere`, hooks, signing.

## Answer

Yes. `src/sequencer.ts` (about 620 lines) and `src/files-adapters.ts` (a FilesApi seen from a
subdirectory, and X5's `RefFiles` over any FilesApi, about 100 lines) implement it on X13's merges
and X14's index. All 9 tests pass:

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

**What git keeps, and we write the same way:**
- **Merge** (builtin/merge.c): `ORIG_HEAD` always (also when already up to date); on a conflict
  `MERGE_HEAD`, `MERGE_MODE` (empty), `MERGE_MSG` (`Merge branch 'x'`, with ` into y` unless y is
  main or master, then `# Conflicts:` and each conflicted path once) and `AUTO_MERGE` (the merged
  tree with markers). The index has the conflict stages, the working tree the merged files.
- **Cherry-pick** (sequencer.c `do_pick_commit`): `CHERRY_PICK_HEAD`, `MERGE_MSG` (the commit's
  message and the conflict list), `AUTO_MERGE`; markers labelled `HEAD` and `<abbrev> (<subject>)`.
  No `ORIG_HEAD`.
- **Committing** (`git commit --no-edit`): the message is `MERGE_MSG` with whitespace cleaned and
  comments kept; a merge has both parents, a cherry-pick keeps the picked commit's author and
  refuses an empty result. `rebase --continue` runs the editor, so its cleanup strips comments.
- **Rebase** (merge backend): `rebase-merge/` holds `head-name`, `onto`, `orig-head`, the todo list
  and `done` (`pick <id> <subject>`), `msgnum`, `end`, and three empty marker files. A stop adds
  `author-script` (shell-quoted, `@<seconds> <tz>` date), `message` (the message and a blank line),
  `stopped-sha`, `REBASE_HEAD`, `MERGE_MSG` and `AUTO_MERGE`. A pick whose parent is HEAD is
  fast-forwarded; a pick that becomes empty is dropped. `REBASE_HEAD` goes with the next pick, so a
  rebase that stopped on its last pick leaves it behind, as git does.
- **Abort**: a reset to HEAD (merge) or to `orig-head` with HEAD reattached (rebase); files the
  index held beyond the target are removed.

**Resume.** No step keeps anything in memory: each reads HEAD, the index and the state files, so a
page reload or a Durable Object's recreation continues where the files say. On a FilesApi, refs use
`filesRefFiles` (one writer at a time; X2's adapters where several writers race).
