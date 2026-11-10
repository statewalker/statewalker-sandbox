# 15 — Can index-pack run in bounded steps that survive the eviction of a Durable Object?

Plan id **X6** (pack ingest/export), slice **X6b2: resumable, time-sliced indexing**. Status: **open**.

## Question

A Durable Object gets a bounded amount of CPU per request and can be evicted between requests;
X6b1's `installPack` indexes a pack in one call (200 000 objects: ~6 s). Can indexing be split into
steps of bounded work — each one resumable from what is stored, with nothing kept in memory
between steps — such that a job interrupted anywhere (between steps or inside one) and resumed,
possibly in a fresh isolate, installs exactly the pack and `.idx` the one-shot run installs?

## Reject condition

Rejected if a resumed job installs anything different from the one-shot run, if a crash inside a
step can corrupt the job, if a step's work is not bounded by its budget (beyond one unit), or if
checkpoints cost storage proportional to steps × pack instead of the pack.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | For X6a's four native-git packs, X6b1's thin packs (with `externalBase`) and a deep comb, a job run in steps of 1, 7 and 1 000 units — with every in-memory structure dropped between steps (cold resume) — installs a pack and `.idx` byte-identical to X6b1's one-shot `installPack`. |
| R2 | Crash inside a step: a FilesApi that fails the n-th storage operation (n swept over a whole job), then resuming with a healthy FilesApi, completes to the same pack and `.idx`; after completion no `tmp_*` file of the job remains. |
| R3 | Checkpoints are log-structured: the bytes written for checkpoints over a whole job are at most 2 × 79 bytes per object plus a constant per step (not proportional to steps × objects). |
| R4 | A step with a budget of U units parses at most U entries or resolves at most U deltas (plus the re-derivation of the bases on the resumed stack); a step with `budgetMs` returns within the budget plus one unit. |
| R5 | In a Durable Object (Miniflare, persistent SQLite storage) a pack is indexed in steps with the runtime disposed and restarted between steps (a real eviction): the result equals Node's. |
| R6 | The SHA-1 state (noble's) exported after any prefix and imported into a fresh hasher gives the digest of the whole input. |
| R7 | Every X6b1 test passes with X6b1's module replaced by this one (`installPack` = a job run to completion in one step). |

## Scope — what this slice does NOT do

- Exploding packs into the native SQL store (X6b3), pack export (X6c).
- Resuming the network transfer itself: the pack is stored (in the receiving request) before the
  job starts.
