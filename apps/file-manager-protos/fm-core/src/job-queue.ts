import type { CheckpointStore } from "./checkpoints.js";
import { type ConflictResolution, runCopyJob } from "./copy-job.js";
import { JobModel } from "./job-model.js";
import type { StorageHandle, StorageRegistry } from "./storage-registry.js";

export interface JobRequest {
  operation: "copy" | "move";
  sourceUri: string;
  targetUri: string;
  targetPath: string;
  roots: string[];
  hooks?: { onStart?(): void; onEnd?(): void };
  onConflict?(
    entry: { path: string; target: string },
    signal: AbortSignal,
  ): Promise<ConflictResolution>;
  onWritten?(targetPath: string): void;
}

export interface JobQueueOptions {
  /** Overrides the target storage's declared batch size, for tests and hosts. */
  batchSize?: number;
  checkpoints?: CheckpointStore;
}

interface Held {
  source: StorageHandle;
  target: StorageHandle;
}

let seq = 0;

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
    const next = lane.then(() => this._run(job, request, held)).catch(() => undefined);
    this._lanes.set(request.targetUri, next);
    return job;
  }

  active(): JobModel[] {
    return [...this._active.values()];
  }

  /** Acquires both endpoints and arms the release as a job cleanup. */
  private _acquire(request: JobRequest, holder: string, job: JobModel): Promise<Held> {
    const acquired: string[] = [];
    job.onCleanup(() => {
      for (const uri of acquired.splice(0)) this._registry.release(uri, holder);
      this._active.delete(job.id);
    });
    // reserve() pins both refcounts synchronously, before the first await, so
    // the panel that started the job can close immediately after.
    const sourceHeld = this._registry.reserve(request.sourceUri, holder);
    acquired.push(request.sourceUri);
    const targetHeld = this._registry.reserve(request.targetUri, holder);
    acquired.push(request.targetUri);
    return Promise.all([sourceHeld, targetHeld]).then(([source, target]) => ({ source, target }));
  }

  private async _run(job: JobModel, request: JobRequest, held: Promise<Held>): Promise<void> {
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
        batchSize: this._options.batchSize ?? this._registry.batchSize(request.targetUri),
        checkpoints: this._options.checkpoints,
        onConflict: request.onConflict,
        onWritten: request.onWritten,
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
