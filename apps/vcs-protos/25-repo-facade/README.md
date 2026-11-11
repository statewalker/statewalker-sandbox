# 25 — Can one repository façade open every backend, report typed errors, cancel within 100 ms, and run git's hooks?

Plan id **X16** (repository façade & contracts), slice **X16b**. Status: **open**.

## Question

X16a gave one command layer over git files and SQL; X8 and X18 added transport and gc. What an
application holds is still a bag of functions and two constructors. The plan's X16 asks for
`Repository.open` on every backend (also inside a Durable Object), an `AbortSignal` honoured within
100 ms, hooks, and `VcsError.code`. Can one façade give that — creating a repository as `git init`
does (HEAD on the default branch; fresh SQL stores had none), reading and writing git's config
(identity from `user.name`/`user.email`), typed errors with stable codes across every layer,
cancellation that leaves no partial state, git's reference-transaction and commit hooks, and the
gc leases X18 left to the writers?

## Reject condition

Rejected if an operation ignores its signal for more than 100 ms or leaves a partial ref update
after an abort, if an error from any layer escapes without a code, if a hook can be bypassed by an
operation that changes refs, or if a repository it creates differs from `git init`'s.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | `openRepository({ files })` / `({ db })` / `init`: a new git-files repository is what `git init --bare` makes (HEAD → refs/heads/<default>, config readable by git); a new SQL repository has the same HEAD; opening an existing one finds its objects and refs. |
| R2 | Config: git's format read and written byte-faithfully (sections, subsections, quoting, comments kept); identity from `user.name`/`user.email` when a commit names none; native `git config --get` reads what we write. |
| R3 | `VcsError` with `code` for every failure class: NOT_FOUND, CONFLICT (stale ref, non-fast-forward), CORRUPT (bad pack, hash mismatch), PROTOCOL, ABORTED, LIMIT, UNSUPPORTED, LOCKED — errors from the pack reader, index-pack, ref transactions, transport and gc map to them. |
| R4 | `AbortSignal` on clone, fetch, push, export, installPack, gc and commit: aborted mid-way, each rejects with ABORTED within 100 ms; no ref changes; temporaries swept. |
| R5 | Hooks: `referenceTransaction(prepared, committed, aborted)` on every ref update through the façade (commit, fetch, push received, gc never); `preCommit`/`commitMsg`/`postCommit` around `commit`; a hook refusing aborts with CONFLICT and nothing changes. |
| R6 | Leases: `commit` and received pushes hold X18's lease from their first object write to their ref update; gc running concurrently never deletes their objects. |
| R7 | The same façade inside a Durable Object (Miniflare): open, commit, log, gc. |

## Scope — what this slice does NOT do

- The worktree and index (X14), merge (X13), sequencer (X15), KV backend (X3 left it at refs).
