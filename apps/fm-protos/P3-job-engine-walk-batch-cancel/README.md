# P3-job-engine-walk-batch-cancel — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/P3-job-engine-walk-batch-cancel/`._

---

<!-- source: 01-P3 rung record and code.md -->

# P3 — Job engine: walk, batch, cancel · rung record

_9 September 2026 · green: 49/49 total (12 new) · mutations killed: 7/7_

## Verdict

The risk concentration is green and the design survived it intact. Promotion
grade: **Adopt**. The P0 `startCopyJob` fake is now dead code and is replaced by
`runCopyJob`.

## The one correction: the move invariant is per-entry, not global pairing

The first version of the move test asserted that every removal is *immediately*
preceded by its own write. It failed — and correctly so. **Parallel batches
interleave**: four writes start together, then four removals land. Strict
pairing is only true at `batchSize: 1`.

The invariant that actually matters, and that the design means, is:

- for each entry, its removal follows **its own** write; and
- removals **interleave** with writes rather than forming a trailing pass.

The test now asserts exactly that: `indexOf("wrote:p") < indexOf("removed:p")`
for every path, plus `firstRemove < lastWrite`. This is what distinguishes
per-entry copy-then-delete from two-pass, and it is the property that makes a
cancelled move reportable.

Worth writing into file 05 §3: the guarantee is per-entry ordering under
concurrency, not sequential pairing.

## Acceptance criteria, as tested

Walk

1. Native recursive `copy()` is **never** called — 10 files, 10 writes.
2. Native `move()` **is** used when source and target share a `storageURI`:
   3 native moves, zero read/write round trips.
3. Enumeration is deterministically sorted by the engine, not left to `list()`.
4. Whole trees are walked and structure recreated (`/src/sub/deep/three.txt`).

Batching

5. Files are processed in parallel batches of the configured size — 10 files at
   `batchSize: 4` yields batches of 4, 4, 2.
6. Progress advances more than once, at batch granularity.

Cancellation

7. A 100-file copy cancels **within one batch boundary**, and `completed % 4 === 0`
   proves it stopped on the barrier rather than mid-batch.
8. A failed write leaves **no partial file**: the target is removed on exception.

Move

9. Per-entry copy-then-delete, interleaved, never a trailing delete pass.
10. A cancelled move reports a precise boundary — `moved N of 40, source retains
    the rest` — and the source retains exactly `40 − N` entries.
11. **No source entry is removed before its target write completed**: a write
    failure on `f0003` leaves `/src/f0003.txt` in place.

Event loop

12. `yieldControl()` between batches keeps timers firing during a 60-file copy —
    the property that stops a large copy freezing the panels.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | delegate to the adapter's recursive `copy()` | 5 |
| M2 | enumeration order left to `list()` | 2 |
| M3 | partial target not removed after a failed write | 1 |
| M4 | move deferred to a trailing delete pass | 2 |
| M5 | cancellation checked only before the walk | 1 |
| M6 | `yieldControl()` removed | 3 |
| M7 | native `move()` not used on same-storage moves | 1 |

M6 failing **3** tests is worth noting: without the yield, cancellation stops
being observable at all, which is the P0 finding confirmed under the real
engine.

## Code

### `src/core/copy-job.ts`

```ts
import type { FilesApi } from "@statewalker/webrun-files";
import type { JobModel } from "./job-model.js";

export interface Endpoint { uri: string; api: FilesApi; path?: string }

export interface JobSpec {
  operation: "copy" | "move";
  source: Endpoint;
  target: Endpoint & { path: string };
  roots: string[];
  batchSize: number;
  job: JobModel;
  onBatch?(batch: string[]): void;
  onEntry?(path: string, phase: "wrote" | "removed"): void;
}

interface Entry { path: string; relative: string }

/** One call per processed item: releases the event loop and offers a checkpoint. */
const yieldControl = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * P3 — the engine walks and transfers file by file, as the only path.
 *
 * `FilesApi.copy()` is recursive but returns a single boolean: no progress, no
 * cancellation, no per-entry conflict resolution, and the adapter's overwrite
 * policy rather than ours. Native `move()` IS used when source and target
 * resolve to the same storageURI, which is detectable from the URI alone.
 */
export async function runCopyJob(spec: JobSpec): Promise<void> {
  const { job, source, target } = spec;
  job.operation = spec.operation;
  const sameStorage = source.uri === target.uri;

  try {
    const entries = await enumerate(source.api, spec.roots);
    job.total = entries.length;
    job.notify();

    for (let i = 0; i < entries.length; i += spec.batchSize) {
      // The batch is the cancellation point and (at P4) the checkpoint barrier.
      if (job.signal.aborted) return job.settle("cancelled");
      const batch = entries.slice(i, i + spec.batchSize);
      spec.onBatch?.(batch.map((e) => e.path));

      await Promise.all(batch.map((entry) => transfer(spec, entry, sameStorage)));

      job.completed += batch.length;
      job.notify();
      await yieldControl();
    }
    if (job.signal.aborted) return job.settle("cancelled");
    job.settle("done");
  } catch (err) {
    job.settle("failed", String((err as Error).message ?? err));
  }
}

/**
 * Deterministic ordered enumeration: the engine sorts rather than trusting
 * `list()` order. Panels sort listings anyway, and it is what makes resume
 * reproducible across runs at P4.
 */
async function enumerate(api: FilesApi, roots: string[]): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const root of roots) {
    for await (const info of api.list(root, { recursive: true })) {
      if (info.kind !== "file") continue;
      entries.push({ path: info.path, relative: info.path.slice(root.length + 1) });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

async function transfer(spec: JobSpec, entry: Entry, sameStorage: boolean): Promise<void> {
  const { source, target, job } = spec;
  const to = `${target.path}/${entry.relative}`;

  if (spec.operation === "move" && sameStorage) {
    await target.api.move(entry.path, to);
    spec.onEntry?.(entry.path, "wrote");
    spec.onEntry?.(entry.path, "removed");
    return;
  }

  try {
    // No AbortSignal on write(): interrupting means throwing from the source
    // iterable, which leaves a partial target behind — so we remove it.
    await target.api.write(to, source.api.read(entry.path, { signal: job.signal }));
  } catch (err) {
    await target.api.remove(to).catch(() => undefined);
    throw err;
  }
  spec.onEntry?.(entry.path, "wrote");

  // Per-entry copy-then-delete: no source entry is removed before its target
  // write completed, so a cancelled move reports a precise boundary instead of
  // leaving a large irreversible delete pass at the end.
  if (spec.operation === "move") {
    await source.api.remove(entry.path);
    spec.onEntry?.(entry.path, "removed");
  }
}
```

### `src/core/job-model.ts` — addition

```ts
  operation: "copy" | "move" = "copy";

  /** A cancelled job reports a precise boundary, not a vague failure. */
  boundary(): string {
    const verb = this.operation === "move" ? "moved" : "copied";
    const tail = this.operation === "move" ? ", source retains the rest" : "";
    return `${verb} ${this.completed} of ${this.total}${tail}`;
  }
```

Suite: `test/p3-job-engine.test.ts`, with a `SpyFilesApi` decorator counting
native `copy()` / `move()` calls, recording write and remove order, and able to
fail on a named path — which is how "no partial file" and "no premature source
removal" are asserted rather than assumed.

## Carried into P4

`enumerate()` returning a sorted array is the precondition for the batch cursor:
resume is only reproducible because run N and run N+1 walk the same order. The
`onBatch` hook is where the checkpoint write attaches.

