# 10 — Can one atomic ref-transaction API run on git files, SQL and KV, with git's semantics?

Plan id **X5** ("Ref transactions"). Status: **in progress.**

## Question

X2 gave a single-ref compare-and-set on git's files backend and X3a one on SQL/KV. Pushes, fetches
and rebases update several refs at once (`git push --atomic`, `update-ref --stdin` transactions,
JGit's `BatchRefUpdate`), and a repository also has a symbolic `HEAD`, `packed-refs` and reflogs.
Can one `RefDb` API — `batch(commands)` with per-ref expected old values, all-or-nothing — be
implemented

- on **git's files layout** over FilesApi primitives, so that native git reads every result and
  both sides' locks exclude each other, and a crash at any step leaves every ref of the batch at
  its old value or every ref at its new value (JGit's `PackedBatchRefUpdate`: pack the involved
  loose refs while holding their locks, then commit the whole batch with one atomic rename of
  `packed-refs.lock`);
- on **SQL** (statewalker-db `Db`) as one transaction (`inTransaction`, which uses
  `storage.transaction` in a Durable Object); and
- on a **KvStore**, which has only single-key compare-and-set — by keeping all refs under one
  root key (snapshot + root CAS)?

## Reject condition

Rejected if any backend applies part of a batch, accepts a name `git check-ref-format` refuses or
refuses one it accepts, accepts a directory/file conflict git refuses, loses an update under
concurrent overlapping batches, or (files) leaves a mix of old and new values after a crash, or
writes refs, packed-refs or reflogs that native git misreads.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Ref names: a table of ≥ 50 names is accepted/refused exactly as `git check-ref-format` (with and without `--allow-onelevel`) decides; every backend refuses a batch containing a refused name. |
| R2 | Atomicity: a batch whose any command's expected old value mismatches (including "must not exist" for an existing ref) changes nothing and reports the mismatching refs; creates, updates and deletes in one batch apply together. Duplicate names, a create below an existing ref (`refs/x` → `refs/x/y`, even if the batch deletes `refs/x`) and parent+child in one batch are refused, as git refuses them. |
| R3 | Symbolic refs: `HEAD → refs/heads/main`; reading resolves; a batch command on `HEAD` updates its target and logs both; `setSymref` is a compare-and-set on the symref's target. |
| R4 | Reflog: each applied command appends `<old> <new> <ident> <time> <tz>\t<message>` to the ref's log. |
| R5 | Concurrency: 20 concurrent batches, each moving two refs from generation n to n+1 with expected old values and retrying on mismatch/locked, end with both refs at the same generation equal to the number of successful batches — on every backend. |
| R6 | Git files interop (Node): native git (`for-each-ref`, `show-ref`, `rev-parse`, `reflog`) reads our loose refs, `packed-refs` (with existing peel lines kept) and logs; we read refs git wrote loose and packed (`pack-refs --all`, peeled tags). Our locks make `git update-ref` fail and git's locks make our batch report `locked`. |
| R7 | Crash (files): a batch over several loose and packed refs, killed at every primitive call in turn, leaves either all old or all new values once stale locks are broken. |
| R8 | Runtimes: the R2–R5 contract passes in Chromium (files on OPFS, SQL on sqlite-wasm, KV in memory) and inside a Durable Object (SQL and KV over `sqlKvStore`). The KV snapshot size for 10 000 refs is recorded against the DO value limit. |

## Scope — what this prototype does NOT do

- No reftable format, no ref advertisement, no remote-tracking semantics (X8).
- No reflog expiry, no `HEAD@{n}` parsing.
- Object existence is not checked: refs point at ids (as `update-ref` with any valid id).
