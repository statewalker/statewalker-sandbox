# P6-job-queue-and-lifetimes — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/P6-job-queue-and-lifetimes/`._

---

<!-- source: 01-P6 rung record and code.md -->

# P6 — Job queue and lifetimes · rung record

_9 September 2026 · green: 74/74 total (8 new) · mutations killed: 6/6 (three after strengthening tests)_

## Verdict

Phase B is complete. Per-storage lanes work, and "a job outlives its panel"
turned out to need **two additions that the design did not name**. Promotion
grade: **Adopt**, with `StorageRegistry.reserve()` promoted back into P2's
module.

## Correction 1 — refcounting must be synchronous even though construction is not

The panel test failed on the first implementation. The job acquired its storages
when its **turn** came, so between `enqueue()` and the lane freeing up there was
a window in which the panel that requested the copy could close and drop the
last reference — disposing a handle or an authentication that may not be
re-acquirable at all.

Moving acquisition to enqueue time was not enough either: `acquire()` is `async`
because credentials resolve asynchronously, so even the first `await` opens the
same window in miniature.

The fix is a new registry primitive:

```ts
reserve(uri, holder): Promise<StorageHandle>
```

which **pins the refcount synchronously** and resolves the instance later,
releasing the holder if construction fails. Bookkeeping is not I/O and must not
inherit its latency.

This belongs in file 04 §3 next to the refcounting rule: *acquire is async,
reservation is not.*

## Correction 2 — `done` must imply "released"

`JobModel.settle()` resolved `done` immediately, while the queue released its
handles afterwards in a `finally`. Anything that re-acquired on completion raced
the release and could observe a disposed instance flickering.

`JobModel.onCleanup(fn)` now runs registered cleanups **before** `done`
resolves, and `settle()` is idempotent. The queue registers its release there.

## The weak mutation worth recording

M3 (defer the reservation) initially **survived** — because it deferred only the
*source* reservation, and the panel test only closed the *target* panel. The
test now closes panels on both endpoints in the same tick, which kills a
deferral of either. A mutation that survives is sometimes a weak mutation rather
than a coverage gap; this one was both, and only widening the test told them
apart.

M6 (rethrow instead of settling) also survived, because the `finally` safety net
settled the job anyway — with a **generic** message. The test now asserts the
failure names the storage, which distinguishes a handled acquisition failure
from a job that merely ended.

## Acceptance criteria, as tested

1. Two jobs targeting one storage serialise: `start:one, end:one, start:two`.
2. Jobs on different storages overlap — both started before either ended.
3. `queue.active()` is the global activity surface, and empties on completion.
4. Each job cancels independently; cancelling one leaves the other `done`.
5. A job cancelled **while queued** never starts, does no work, and reports no
   end — `onEnd` pairs with `onStart`.
6. Both endpoints stay live when the panels that started the copy close in the
   same tick, and are released when the job ends.
7. Release happens before `done` resolves.
8. A storage that cannot be acquired fails **its** job with a reason naming the
   storage, and the lane stays usable for the next job.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | no per-storage lane (everything parallel) | 1 |
| M2 | one global lane (nothing parallel) | 1 |
| M3 | source reservation deferred | 1 (after widening) |
| M3b | target reservation deferred | 1 (after widening) |
| M4 | cleanup deferred until after `done` resolves | 2 |
| M5 | a job cancelled while queued still runs | 1 |
| M6 | acquisition failure rethrown instead of settled | 1 (after asserting the message) |

## Code

### `src/core/storage-registry.ts` — the P6 addition

```ts
  /**
   * Pins the refcount SYNCHRONOUSLY and resolves the instance asynchronously.
   *
   * Construction is async (credential resolution), but bookkeeping must not be:
   * a caller that awaits its acquisition has a window in which another holder's
   * release can dispose the instance out from under it. `reserve` closes that
   * window, and is what lets a job be enqueued without racing the panel that
   * started it.
   */
  reserve(uri: string, holder: string): Promise<StorageHandle> {
    let entry = this._entries.get(uri);
    if (!entry) {
      entry = { holders: new Set(), status: "idle" };
      this._entries.set(uri, entry);
    }
    entry.holders.add(holder);
    return this.acquire(uri, holder).catch((err) => {
      this.release(uri, holder);
      throw err;
    });
  }
```

### `src/core/job-model.ts` — the P6 addition

```ts
  private readonly _cleanups: (() => void)[] = [];

  /**
   * Registered by whoever holds resources on the job's behalf. Cleanups run
   * BEFORE `done` resolves, so "the job finished" implies "its storages are
   * released" — otherwise an observer that re-acquires on completion races the
   * release and sees an instance flicker.
   */
  onCleanup(fn: () => void): void { this._cleanups.push(fn); }

  settle(status: JobStatus, error?: string): void {
    if (this.status !== "running") return;   // idempotent
    this.status = status;
    this.error = error;
    for (const fn of this._cleanups.splice(0)) fn();
    this.notify();
    this._resolveDone();
  }
```

### `src/core/job-queue.ts`

```ts
/**
 * P6 — two levels of concurrency, keyed by `storageURI`.
 *
 * BETWEEN jobs: one mutating job per target storage, unlimited storages in
 * parallel. A copy to S3 and a copy to OPFS run together; two copies to S3
 * queue. WITHIN a job: parallel batches, which is the engine's business.
 *
 * The queue acquires both endpoints for the job's own lifetime and releases
 * them when it ends — which is what makes a job independent of the panel that
 * started it, since the panel's release no longer disposes anything.
 */
export class JobQueue {
  private readonly _lanes = new Map<string, Promise<void>>();
  private readonly _active = new Map<string, JobModel>();

  constructor(
    private readonly _registry: StorageRegistry,
    private readonly _options: JobQueueOptions = {},
  ) {}

  enqueue(request: JobRequest): JobModel {
    const job = new JobModel(`job-${++seq}`);
    job.operation = request.operation;
    this._active.set(job.id, job);

    // Acquisition happens NOW, not when the job's turn comes. A queued job that
    // acquired nothing would let the panel that started it drop the last
    // reference — disposing a handle or an authentication that may not be
    // re-acquirable — in the gap before the lane frees up.
    const holder = `job:${job.id}`;
    const held = this._acquire(request, holder, job);

    const lane = this._lanes.get(request.targetUri) ?? Promise.resolve();
    const next = lane.then(() => this._run(job, request, holder, held)).catch(() => undefined);
    this._lanes.set(request.targetUri, next);
    return job;
  }

  active(): JobModel[] { return [...this._active.values()]; }

  /** Acquires both endpoints and arms the release as a job cleanup. */
  private async _acquire(request: JobRequest, holder: string, job: JobModel) {
    const acquired: string[] = [];
    job.onCleanup(() => {
      for (const uri of acquired.splice(0)) this._registry.release(uri, holder);
      this._active.delete(job.id);
    });
    // reserve() pins both refcounts synchronously, before this function's first
    // await, so the panel that started the job can close immediately after.
    const sourceHeld = this._registry.reserve(request.sourceUri, holder);
    acquired.push(request.sourceUri);
    const targetHeld = this._registry.reserve(request.targetUri, holder);
    acquired.push(request.targetUri);
    return { source: await sourceHeld, target: await targetHeld };
  }

  private async _run(job, request, holder, held): Promise<void> {
    let started = false;
    try {
      const { source, target } = await held;
      // A job cancelled while queued must never start.
      if (job.signal.aborted) return job.settle("cancelled");

      started = true;
      request.hooks?.onStart?.();
      await runCopyJob({
        operation: request.operation,
        source: { uri: source.uri, api: source.api },
        target: { uri: target.uri, api: target.api, path: request.targetPath },
        roots: request.roots,
        batchSize: this._options.batchSize ?? 8,
        checkpoints: this._options.checkpoints,
        onConflict: request.onConflict,
        job,
      });
    } catch (err) {
      // An unacquirable storage fails ITS job and leaves the lane usable.
      job.settle("failed", String((err as Error).message ?? err));
    } finally {
      job.settle("failed", "job ended without settling"); // no-op if already settled
      // onEnd pairs with onStart: a job cancelled while queued never ran, so it
      // never reports an end either.
      if (started) request.hooks?.onEnd?.();
    }
  }
}
```

## Phase B is closed

`fm-core` is complete and Node-testable with no DOM: registry, engine,
checkpoints, conflicts, queue. 74 tests, 29 mutations killed across five rungs.
Next is Phase C (P7 panel algebra, P8 listing lifecycle, P9 model discipline,
P10 notification, P11 command surface), which needs no new dependencies.

