import type { FilesApi } from "@statewalker/webrun-files";
import type { CheckpointStore, JobError } from "./checkpoints.js";
import type { JobModel } from "./job-model.js";

export interface Endpoint {
  uri: string;
  api: FilesApi;
  path?: string;
}

export interface ConflictResolution {
  resolution: "overwrite" | "skip" | "rename";
  applyToAll: boolean;
}

export interface JobSpec {
  operation: "copy" | "move";
  source: Endpoint;
  target: Endpoint & { path: string };
  roots: string[];
  batchSize: number;
  job: JobModel;
  onBatch?(batch: string[]): void;
  onEntry?(path: string, phase: "wrote" | "removed"): void;
  /**
   * The TARGET path of a completed write. `onEntry` reports source paths so a
   * move's write/remove pair is traceable on one path; change notification
   * needs the other end, and conflating them would make one of the two lie.
   */
  onWritten?(targetPath: string): void;
  checkpoints?: CheckpointStore;
  /** Re-enqueue of an interrupted job: entries before its cursor are skipped. */
  resumeFrom?: string;
  shouldSkip?(path: string): boolean;
  /**
   * Injected as a callback on the SPEC, never as a presentation dependency:
   * fm-core must be usable with no view vocabulary anywhere in it. The app
   * layer passes a resolver that goes through its dialog mechanism, a test
   * passes a constant, an agent passes its own policy.
   */
  onConflict?(
    entry: { path: string; target: string },
    signal: AbortSignal,
  ): Promise<ConflictResolution>;
  /** Used when no callback is supplied, so the simple case needs nothing. */
  conflictPolicy?: "overwrite" | "skip" | "rename";
}

interface Entry {
  path: string;
  relative: string;
}

interface Conflicts {
  applyToAll?: ConflictResolution["resolution"];
  pending?: Promise<unknown>;
}

/** One call per batch: releases the event loop and offers a checkpoint. */
const yieldControl = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * C0.5 — the engine enforces cancellation on the source stream ITSELF, rather
 * than trusting the adapter to honour `ReadOptions.signal`.
 *
 * `FilesApi.read`'s options have carried `signal?: AbortSignal` with the comment
 * "AbortSignal for cancellation support" since `webrun-files@0.7.0`, and
 * `transfer()` below passed it and relied on the adapter throwing. NO SHIPPED
 * ADAPTER IMPLEMENTS IT: `MemFilesApi`, `NodeFilesApi` and `BrowserFilesApi` all
 * accept `ReadOptions` and all three ignore `signal`. Two of them additionally
 * swallow every read error (`catch { return; }`), so a read cannot signal failure
 * by throwing either — it ends early and silently.
 *
 * The consequence, measured on real OPFS and on a real directory before this
 * existed: cancelling a job mid-write did not interrupt anything. All 64 chunks
 * of a 512 KiB file arrived after `cancel()`, the write completed, and the entry
 * was reported written — so "leaves no partial file behind when a write is
 * interrupted" was a promise about a code path that could not be reached.
 * `MemFilesApi` hid it twice over, because it yields the whole file as ONE chunk
 * and there is no mid-stream to interrupt.
 *
 * The signal is still passed down, deliberately: an adapter that does implement
 * it can stop reading at the source instead of being unwound one chunk later.
 * This is the floor, not a replacement.
 */
async function* abortableSource(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  // Checked BEFORE the first chunk as well as between chunks: a job cancelled
  // while its batch was being assembled must not write a first byte.
  if (signal.aborted) throw new Error("job cancelled");
  for await (const chunk of source) {
    if (signal.aborted) throw new Error("job cancelled");
    yield chunk;
  }
}

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
  const conflicts: Conflicts = {};
  const errors: JobError[] = [];
  let written = 0;

  try {
    const all = await enumerate(source.api, spec.roots);
    // Resume skips what the cursor records as done. Because enumeration is
    // deterministically sorted, run N+1 walks the same order as run N, so a
    // path comparison is enough — no list of completed files is needed.
    const resumed = spec.resumeFrom ? await spec.checkpoints?.load(spec.resumeFrom) : undefined;
    const entries = resumed ? all.filter((e) => e.path > resumed.cursorPath) : all;
    job.total = entries.length;
    job.notify();

    for (let i = 0; i < entries.length; i += spec.batchSize) {
      // The batch is the cancellation point and the checkpoint barrier.
      if (job.signal.aborted) return job.settle("cancelled");
      const batch = entries.slice(i, i + spec.batchSize);
      spec.onBatch?.(batch.map((e) => e.path));

      const skipped = batch.filter((e) => spec.shouldSkip?.(e.path));
      for (const entry of skipped) errors.push({ path: entry.path, reason: "skipped" });
      const doable = batch.filter((e) => !spec.shouldSkip?.(e.path));

      await Promise.all(
        doable.map((entry) => transfer(spec, entry, sameStorage, conflicts, errors)),
      );

      job.completed += batch.length;
      job.notify();

      // The batch is the checkpoint barrier: the cursor is rewritten after
      // every batch, so a crash costs one batch, never a flush interval.
      await spec.checkpoints?.save(job.id, {
        lastCompletedBatch: Math.floor(i / spec.batchSize),
        cursorPath: batch[batch.length - 1].path,
        remaining: entries.length - job.completed,
        spec: {
          operation: spec.operation,
          source: { uri: source.uri },
          target: { uri: target.uri, path: target.path },
          roots: spec.roots,
          batchSize: spec.batchSize,
        },
      });

      // Errors ride the SAME barrier as the cursor. Written only at the end of
      // the job, a cancellation returning from inside the loop would lose the
      // record — and the resumed job would ask the user about entries they had
      // already answered for.
      if (errors.length > written) {
        await spec.checkpoints?.recordErrors(job.id, errors);
        written = errors.length;
      }

      await yieldControl();
    }
    if (job.signal.aborted) return job.settle("cancelled");
    await spec.checkpoints?.clear(job.id);
    job.settle("done");
  } catch (err) {
    // An aborted decision is cancellation, not failure: the resolver rejects
    // because the job was cancelled, and reporting that as a failure would put
    // a scary error in front of a user who simply pressed Escape.
    if (job.signal.aborted) return job.settle("cancelled");
    job.settle("failed", String((err as Error).message ?? err));
  }
}

/**
 * Deterministic ordered enumeration: the engine sorts rather than trusting
 * `list()` order. Panels sort listings anyway, and it is what makes resume
 * reproducible across runs at P4.
 *
 * A root is whatever the user highlighted, so it may be a FILE. Assuming every
 * root is a directory made a selection of individual files enumerate to
 * nothing, and the job "succeeded" having copied zero entries.
 */
async function enumerate(api: FilesApi, roots: string[]): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const root of roots) {
    const stats = await api.stats(root);
    if (stats?.kind === "file") {
      entries.push({ path: root, relative: root.slice(root.lastIndexOf("/") + 1) });
      continue;
    }
    for await (const info of api.list(root, { recursive: true })) {
      if (info.kind !== "file") continue;
      entries.push({ path: info.path, relative: info.path.slice(root.length + 1) });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

async function transfer(
  spec: JobSpec,
  entry: Entry,
  sameStorage: boolean,
  conflicts: Conflicts,
  errors: JobError[],
): Promise<void> {
  const { source, target, job } = spec;
  let to = `${target.path}/${entry.relative}`;

  // Conflict detection is exists() then write(): a TOCTOU race, since FilesApi
  // has no exclusive create. Accepted for now; the `.part` + move() protocol
  // closes it later as an opt-in mode.
  if (await target.api.exists(to)) {
    const decision =
      conflicts.applyToAll ??
      (spec.onConflict
        ? await resolveConflict(spec, entry, to, conflicts)
        : (spec.conflictPolicy ?? "overwrite"));
    if (decision === "skip") {
      errors.push({ path: entry.path, reason: "skipped" });
      job.skipped.push(entry.path);
      return;
    }
    if (decision === "rename") to = rename(to);
  }

  if (spec.operation === "move" && sameStorage) {
    await target.api.move(entry.path, to);
    spec.onEntry?.(entry.path, "wrote");
    spec.onWritten?.(to);
    spec.onEntry?.(entry.path, "removed");
    return;
  }

  try {
    // No AbortSignal on write(): interrupting means throwing from the source
    // iterable, which leaves a partial target behind — so we remove it. The
    // throw is `abortableSource`'s, not the adapter's; see its comment for why
    // the adapter cannot be relied on to produce one.
    await target.api.write(
      to,
      abortableSource(source.api.read(entry.path, { signal: job.signal }), job.signal),
    );
  } catch (err) {
    await target.api.remove(to).catch(() => undefined);
    throw err;
  }
  spec.onEntry?.(entry.path, "wrote");
  spec.onWritten?.(to);

  // Per-entry copy-then-delete: no source entry is removed before its target
  // write completed, so a cancelled move reports a precise boundary instead of
  // leaving a large irreversible delete pass at the end.
  if (spec.operation === "move") {
    await source.api.remove(entry.path);
    spec.onEntry?.(entry.path, "removed");
  }
}

/**
 * The resolver is interruptible by the job's AbortSignal, and only ONE
 * decision is in flight at a time — a second conflict in the same batch waits
 * for the first answer and then re-reads `applyToAll`. Without that,
 * "apply to all remaining" degrades to "all remaining, minus the rest of this
 * batch", and the larger the batch the worse it looks.
 */
async function resolveConflict(
  spec: JobSpec,
  entry: Entry,
  to: string,
  conflicts: Conflicts,
): Promise<ConflictResolution["resolution"]> {
  while (conflicts.pending) {
    await conflicts.pending.catch(() => undefined);
    if (conflicts.applyToAll) return conflicts.applyToAll;
  }
  const ask = spec.onConflict?.({ path: entry.path, target: to }, spec.job.signal);
  if (!ask) return spec.conflictPolicy ?? "overwrite";
  conflicts.pending = ask;
  try {
    const answer = await ask;
    if (answer.applyToAll) conflicts.applyToAll = answer.resolution;
    return answer.resolution;
  } finally {
    conflicts.pending = undefined;
  }
}

function rename(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/")
    ? `${path.slice(0, dot)} (2)${path.slice(dot)}`
    : `${path} (2)`;
}
