# C0-packages-and-core-decisions — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/C0-packages-and-core-decisions/`._

---

<!-- source: 01-C0 rung record and code.md -->

# C0 — Packages, CI boundaries, and the three open core decisions · rung record

_9 September 2026 · green: 96/96 (22 new since P6) · mutations killed: 7/7 (two after strengthening)_

## Verdict

The tree is now three packages with the boundary grep running on every commit,
and the three decisions Phase B left open are closed with tests. Promotion
grade: **Adopt**.

Two genuine bugs surfaced during what was supposed to be a no-new-behaviour
rung. Both were hidden by the prototype layout, which is the argument for doing
this promotion early rather than at the end.

## Layout

```
packages/fm-core/src   registry, engine, checkpoints, conflicts, queue, stats
packages/fm-app/src    declarations, models, controllers, bootstrap, model-kit
packages/fm-ui/src     (empty until D1)
test/boundaries.test.ts
```

Cross-package imports resolve through `@fm/core`, `@fm/app`, `@fm/ui` aliases.
The P0 fake `job-engine.ts` is **deleted**; the app controller now drives the
real `runCopyJob`.

## Bug 1 — the engine could not copy a file, only a directory

Deleting the P0 fake exposed it immediately. `enumerate()` assumed every root
was a directory and called `list(root, { recursive: true })` on it — so a
selection of individual files enumerated to nothing and the job "succeeded"
having copied zero entries.

Nobody would have chosen this: it survived because P3–P6 always tested with a
directory root, and P0 used the fake. A selection is whatever the user
highlighted, and refusing mixed selections would push the walk back into every
caller. `enumerate()` now stats each root: a file contributes itself under its
basename, a directory contributes its tree under root-relative paths.

## Bug 2 — a cancelled job lost its skip record

`recordErrors()` ran only after the loop, and cancellation returns from inside
it. So a job cancelled after the user chose "skip" on some entries wrote no
`errors.json`, and the resumed job would ask about them **again** — after the
user had already answered.

Errors now ride the same barrier as the cursor: written per batch when the list
grows. This is the P4 principle applied to the thing P4 did not checkpoint, and
it is only visible once discard/retention is tested.

The strengthened retention test is what found it. The original version
discarded a job that had produced no errors at all, so `errors.json` never
existed and the assertion passed vacuously — a mutation surviving (C0-M2) was
the clue.

## The three decisions, now closed

**Batch size and parallelism.** `DEFAULTS.batchSize = 8`, declared **per
storage** and governed by the **target** — it is the side being written to. Small
enough that a batch boundary comes quickly (cancellation feels immediate, a
crash costs little), large enough to amortise remote latency. Parallelism
within a batch *is* the batch size; a second knob would only let the two
disagree.

**A cancelled copy reports, it does not clean up.** Already-copied entries stay.
Deleting them would destroy data the user can see and might want, and a
cancelled copy has taken nothing away. The boundary is the report:
`copied N of M`. (A cancelled *move* keeps its existing, stronger report:
`moved N of M, source retains the rest`.)

**Checkpoint retention: no age-based expiry.** A resumable job is a promise to
the user and time does not revoke it — the case where an age rule would fire is
a long-abandoned large transfer, which is exactly the case worth keeping. Only
`discard(jobId)` (explicit) or successful completion removes a cursor.
`discard` removes the cursor **and** `errors.json`, or a re-enqueued job
inherits stale skips. `pruneCompleted()` removes only records whose job
finished while the startup report was open.

## The boundary suite (standing, not per-rung)

`test/boundaries.test.ts` asserts, over the actual files with comments
stripped:

- `fm-core` names no `ui:` command, imports no `@fm/app` or `@fm/ui`, and
  touches no DOM global;
- `fm-app` imports no `@fm/ui` and touches no DOM global;
- `fm-ui` never imports `@fm/core` directly.

The DOM-global check is new: "Node-testable with no DOM" was a claim in file 07
that nothing verified.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| C0-M1 | queue ignores per-storage `batchSize` | 1 |
| C0-M2 | `discard` leaves `errors.json` behind | 1 (after strengthening) |
| C0-M3 | `pruneCompleted` prunes on age (everything) | 1 |
| C0-M4 | file roots dropped from enumeration | 3 |
| C0-M5 | `onWritten` reports the source path | 2 (after targeting the copy path) |
| C0-M6 | errors written only at the end of the job | 1 |
| C1-M1 | `probe` fires on every notify | 2 |

C0-M5 first survived because the mutation landed in the same-storage **move**
branch, which no copy test reaches — the §2.6 symmetry rule from file 16,
hitting on its first outing.

## Code — the new seams

```ts
// storage-registry.ts
export const DEFAULTS = { batchSize: 8 } as const;

  /** Declared per storage: a rate-limited remote is not OPFS. */
  batchSize?: number;

  /** The TARGET storage governs a job's batching: it is the side being written. */
  batchSize(uri: string): number {
    return this._configs.get(uri)?.batchSize ?? DEFAULTS.batchSize;
  }
```

```ts
// copy-job.ts — roots may be files or directories
    const stats = await api.stats(root);
    if (stats?.kind === "file") {
      entries.push({ path: root, relative: root.slice(root.lastIndexOf("/") + 1) });
      continue;
    }
```

```ts
// copy-job.ts — errors ride the checkpoint barrier
      if (errors.length > written) {
        await spec.checkpoints?.recordErrors(job.id, errors);
        written = errors.length;
      }
```

```ts
// copy-job.ts — target-path hook, distinct from source-path tracing
  /**
   * The TARGET path of a completed write. `onEntry` reports source paths so a
   * move's write/remove pair is traceable on one path; change notification
   * needs the other end, and conflating them would make one of the two lie.
   */
  onWritten?(targetPath: string): void;
```

```ts
// checkpoints.ts — retention
  async discard(jobId: string): Promise<void> { /* cursor + errors.json */ }
  async pruneCompleted(): Promise<string[]> { /* remaining === 0 only */ }
```

