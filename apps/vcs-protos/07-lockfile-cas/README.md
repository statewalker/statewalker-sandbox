# 07 — Can git's lock-file protocol give a crash-safe, linearizable ref compare-and-set on FilesApi, interoperating with native git?

Plan id **X2** (FilesApi atomic primitives). Status: **in progress**.

## Question

webrun-vcs updates refs with read-then-write: no lock files, no atomic replace (review finding: lost
updates, torn files, native git unaware of our writes). FilesApi has neither an exclusive create nor
an atomicity guarantee for `write`/`move` (the Node adapter overwrites in place; the browser adapter's
`move` can fall back to copy-then-delete). Git and JGit (`LockFile`) solve ref updates with
**`<ref>.lock`**: create it exclusively, write the new value into it, rename it over the ref; an
existing lock means "busy" and is never broken silently.

Can that protocol be implemented over FilesApi plus **two minimal primitives** — `createExclusive`
and `replace` (atomic rename-over) — on memory, Node fs and OPFS, giving a compare-and-set that is
linearizable, crash-safe, and **interoperable with native git** on the same directory?

The lock protocol is chosen over the alternatives in the plan (versioned files, append-only log)
because it is what git itself does: anything else would not be seen by native git (decision D3).

## Reject condition

Rejected if, on any adapter: two concurrent compare-and-sets from the same expected value both
succeed; a crash at any step leaves a ref torn, empty or silently changed; native git can update a
ref while our lock is held, or we can while git's lock is held; or a primitive cannot be provided at
all on one of the three backends.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | 100 concurrent `casRef` calls from the same expected value on one store: exactly one returns `ok`; the others return `mismatch` or `locked`; the final value is the winner's; no `.lock` is left. Runs on memory, Node fs and (R6) OPFS. |
| R2 | 8 Node processes racing on the same directory: exactly one `ok`, final value is that process's. |
| R3 | Native git interop on a real repository: (a) while we hold `refs/heads/main.lock`, `git update-ref` fails; (b) while a git-style lock exists, `casRef` returns `locked` and changes nothing; (c) a value written by `casRef` is what `git rev-parse` reports, and `git fsck` is clean; (d) a value written by `git update-ref` is what we read. |
| R4 | A crash (injected failure) after each step — lock created, lock written, before replace, during replace — leaves the ref with its old or new value, never torn or missing; a crash that leaves a lock makes later `casRef` return `locked` (git does not steal locks either); an explicit `breakLock` recovers. |
| R5 | `createExclusive` on an existing path returns `false` without changing it; `replace` overwrites the target in one step (a reader never sees a partial or missing file). |
| R6 | In Chromium on OPFS: R1 in one page, and two Dedicated Workers racing on the same OPFS directory produce exactly one winner. |

## Scope — what this prototype does NOT do

- No packed-refs, reflog, symbolic refs or multi-ref transactions (X5).
- No KvStore/SQL compare-and-set (X3); FilesApi only.
- No change to webrun-files itself: the primitives are prototyped as adapters around existing FilesApi implementations.
- No CellB/celld, Firefox or WebKit.
