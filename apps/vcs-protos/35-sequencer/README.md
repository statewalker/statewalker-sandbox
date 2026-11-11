# 35 — Can git and webrun-vcs finish each other's merges, cherry-picks and rebases?

Plan id **X15** (sequencer & git op-state). Status: **open**.

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
- Out of scope: `--rebase-merges`, interactive todo editing, `--onto`, autostash, dropping commits
  already upstream by patch id (the corpus has none), octopus merges, `rerere`, hooks, signing.
