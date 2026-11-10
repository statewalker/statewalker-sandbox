# 15 — Can index-pack run in bounded steps that survive the eviction of a Durable Object?

Plan id **X6** (pack ingest/export), slice **X6b2: resumable, time-sliced indexing**. Status: **answered — yes: steps of any size, cold or after a crash at any storage operation, install exactly the one-shot pack and `.idx`; checkpoints cost ~79 bytes per entry once plus a constant per step; a Durable Object restarted between every step completes to git's `.idx`.**

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

## Answer

**Yes.** `startIndexJob(files, packDir, stream)` stores the pack and commits the first state;
`stepIndexJob(files, packDir, id, { units, budgetMs, externalBase })` runs one step and commits a
checkpoint; the step that installs the pack returns the result. `installPack` (X6b1's interface)
is the same machine run to completion in one call without checkpoints — X6b1's whole suite passes
against it (R7).

- **Units.** A step stops between units: an entry parsed (phase 1), a delta resolved or a root
  loaded (phase 2), a base looked up (thin completion). Writing the idx and installing are their
  own committed phases. `budgetMs` is checked between units, after a cold resume's replay.
- **Checkpoints are log-structured.** A step appends the entries it created or resolved — 79
  bytes each, an 8-byte header linking to the previous segment — writes the resolver stack (17
  bytes a level) when a subtree is in progress, and commits by writing a new generation of the
  state: JSON plus its SHA-1, at most 683 bytes here whatever the step count (the first version
  listed every segment in the state and grew 20 bytes a step: fixed before the review). The newest
  generation that verifies wins, so a torn write falls back to the previous one; uncommitted
  segments of a crashed step are overwritten by its retry.
- **Resuming** replays the log into the typed tables (X6b1's 75 bytes an entry) and restores the
  stack without contents: the bases of the frames in progress are re-derived along the recorded
  base links (X6b1's `derive`). The pack checksum continues through the exported SHA-1 state
  (noble's fields, wrapped in `sha1-state.ts` and pinned by R6). A warm isolate keeps the table
  between steps and skips the replay.
- **Install and cleanup are idempotent, committed phases.** The pack is moved before the idx;
  `cleanup` is committed before the job's files are removed, removes the state last and lets
  failures propagate, so a crash anywhere resumes into a step that finishes the work. A resumed
  cleanup reads the installed `.idx` (its logs may be gone) and does not offer `entries`. The
  failure sweep found two bugs this way before the review: a swallowed removal left a log
  behind, and a crash among the removals replayed a state whose logs were deleted — read as
  empty files, they rebuilt zeroed entries and a wrong `.idx`. Segment lengths are now checked.
- A malformed pack (PackError) ends the job and removes its temporaries; any other failure leaves
  it at its last checkpoint.
- **One stepper at a time** (found by the review: two concurrent steppers wedged 24 of 200 jobs).
  Steps of a job in one isolate are serialized — a DO's alarm and fetch interleave at I/O — and a
  commit refuses (`ConcurrentStepError`, the job intact) when the newest generation moved during
  the step. Across isolates or processes that check narrows the race but is not a lock (FilesApi
  has no compare-and-swap): run one stepper per job there (one DO per job, or X5's ref
  compare-and-set as a lease).
- **Every step makes progress**: the first unit is always granted, so a step whose setup outlasts
  `budgetMs` still advances (the review found 218 steps doing nothing with an 8 ms budget).
- **Warm steps keep the resolver** — its stack and cached bases — besides the table (at most 4
  jobs per isolate). A cold step replays the log (O(entries)), rebuilds the resolver's indexes
  (O(n + REF log REF)) and re-derives the bases of the stack in progress (O(depth) patches): with
  many small cold steps a job is O(n × steps); the deep comb shows it (below).
- **Thin completion**: the open batch of appended entries is rewritten in place at each
  checkpoint until it is full, so batch files and the segment list grow with the appended bytes
  (one per MiB), not with the steps; the state also lists the missing base ids. The review found
  one file and one segment per step (300 bases in 1-unit steps: 300 files, a 20 KB state).
- **Not bounded by the budget**: one unit can be large (a 1 GiB entry, or the re-derivation of a
  deep stack on a cold resume), and the finish phase (re-hashing a completed thin pack, sorting
  the idx) is one step of O(pack) work. In production Workers the clock advances only on I/O, so
  `budgetMs` may not stop a CPU-bound step: budget by `units` there (Miniflare does not show this).

## Verified

All 17 Node tests and the 24 X6b1 tests re-run against this module pass
(`pnpm test 15-resumable-index`). The tests were written alongside the implementation rather than
before it; the mutation table below stands in for the red runs.

| # | Result |
|---|---|
| R1 | OFS, REF, `gc --aggressive`, a 4 MiB blob with a delta child, a 300-deep comb, and two thin packs (with `externalBase` over the receiver's object database): in steps of 1, 7 and 1 000 units (7 and 1 000 for the aggressive pack), every step cold, the installed pack, its id and the `.idx` are byte-identical to X6b1's one-shot install; only `pack-*` files remain. A malformed pack ends the job with PackError and leaves nothing. |
| R2 | A job on Node files (steps of 25 units), failed once at each of its storage operations in turn (reads fail, writes fail after half their first chunk — torn files, removals/moves/stats fail), then resumed cold on healthy storage: every run installs git's `.idx` and leaves only `pack-*` files. |
| R2b | Storage that loses or corrupts a checkpoint: a missing log segment, a segment truncated by one whole record, a digit changed in the newest state — each fails the resume (never replayed as wrong entries). |
| R3 | 210 objects in 48 steps of 7 units: 26 612 bytes of log (≤ 2 × 79 × 210 + 8 per step), 29 268 bytes of state (≤ 683 per generation), 561 bytes of stack. |
| R4 | Steps of 1, 7 and 50 units never use more; a 40 000-entry pack with `budgetMs: 20` (warm) took several steps, each one's work within 20 ms plus its longest unit plus 5 ms. |
| R5 | X6a's fixture pack indexed in a Durable Object (SqliteFilesApi, Miniflare with persistent storage) in steps of 40 units, the runtime disposed and recreated for every step: git's `.idx`, only `pack-*` files left. |
| R6 | The SHA-1 state exported after every prefix of 3 000 bytes (every split up to 200, then every 37th) and imported into a fresh hasher finishes to the whole input's digest; also across two exports. |
| R7 | X6b1's 24 Node tests pass with X6b1's module replaced by this one. |

### Mutation check

Each mutation applied alone to `src/index-job.ts`, the matching tests run (`-t`), file restored.

| Mutation | Caught by |
|---|---|
| N1 SHA-1 state not carried across parse steps | R1 (7: checksum mismatch) |
| N2 state checksum not verified | R2b corrupted digit (added: the crash sweep's torn states never had a newline) |
| N3 log length not checked on replay | R2b truncated segment (added: a missing file still failed its existence check) |
| N4 resolver stack not checkpointed | R1 (7) |
| N5 install not committed before cleanup | R2 |
| N6 finish not committed before install | R2 |
| N7 cleanup removals best effort | R2 (a log left behind) |
| N8 parse ignores the budget | R4 (2) |
| N9 resolved deltas not logged | R1 (7) |
| N10 appended bases not logged | R1 thin packs (2) |
| N12 log segments not chained | R1 (7) |

## Functional description

```ts
// in the request that receives the pack
const id = await startIndexJob(files, "/.git/objects/pack", stream);
// later steps (alarms, other requests), until done
for (;;) {
  const r = await stepIndexJob(files, "/.git/objects/pack", id, { budgetMs: 200, externalBase });
  if (r.done) break; // r.result: { packId, count, idx, entries, stats }
}
```

## Interfaces produced

```ts
function startIndexJob(files, packDir, source, opts?: InstallOptions): Promise<string>;
function stepIndexJob(files, packDir, id, opts?: { units?; budgetMs?; externalBase?; cold? }):
  Promise<{ done: false; phase; units; workMs; maxUnitMs } | { done: true; result: InstallResult; ... }>;
function installPack(files, packDir, source, opts?): Promise<InstallResult>;   // X6b1's
function exportSha1(h): Uint8Array; function importSha1(state): Sha1;          // sha1-state.ts
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/index-job.ts` | **Adopt** | supersedes X6b1's module: same results, resumable in steps |
| `src/sha1-state.ts` | **Adopt** (watch) | depends on noble's undocumented fields; R6 pins them, a small own SHA-1 is the fallback |
| `src/do-entry.ts` | **Source** | DO harness with restarts |

## Open threads (ranked by how much later work they would invalidate)

1. **X6b3**: exploding a pack into the native SQL store (X3b) in batched transactions — the same
   step machine, with the inserts as the unit.
2. A cold resume replays the whole log (≤ 2 × 79 bytes an entry) and rebuilds the resolver's
   indexes (a sort of the REF entries): fine for 200 000 objects, a compaction (one snapshot
   segment) if steps become frequent and cold.
3. The network transfer itself is not resumable: the pack is stored in one request.
