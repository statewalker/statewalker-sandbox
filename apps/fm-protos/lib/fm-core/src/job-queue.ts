import { runCopyJob, type ConflictResolution } from "./copy-job.js";
import { JobModel } from "./job-model.js";
import type { CheckpointStore } from "./checkpoints.js";
import type { StorageRegistry } from "./storage-registry.js";

export interface JobRequest {
  operation: "copy" | "move" | "delete";
  sourceUri: string;
  targetUri: string;
  targetPath: string;
  roots: string[];
  onConflict?(entry: { path: string; target: string }, signal: AbortSignal): Promise<ConflictResolution>;
  hooks?: { onStart?(): void; onEnd?(): void };
}

export interface JobQueueOptions {
  batchSize?: number;
  checkpoints?: CheckpointStore;
  onBatch?(batch: string[]): void;
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
  private readonly _byId = new Map<string, JobModel>();

  constructor(
    private readonly _registry: StorageRegistry,
    private readonly _options: JobQueueOptions = {},
  ) {}

  enqueue(request: JobRequest): JobModel {
    const job = new JobModel(`job-${++seq}`);
    job.operation = request.operation;
    this._active.set(job.id, job);
    this._byId.set(job.id, job);

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

  /** Live jobs by id, so a caller that received a jobId can await or cancel it. */
  get(id: string): JobModel {
    const job = this._byId.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }

  active(): JobModel[] {
    return [...this._active.values()];
  }

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

  private async _run(
    job: JobModel,
    request: JobRequest,
    holder: string,
    held: ReturnType<JobQueue["_acquire"]>,
  ): Promise<void> {
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
        // The target storage declares the batching, not the queue.
        batchSize: this._options.batchSize ?? this._registry.batchSize(target.uri),
        onBatch: this._options.onBatch,
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
