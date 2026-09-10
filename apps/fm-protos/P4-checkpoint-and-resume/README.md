# P4-checkpoint-and-resume — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/P4-checkpoint-and-resume/`._

---

<!-- source: 01-P4 rung record and code.md -->

# P4 — Checkpoint and resume · rung record

_9 September 2026 · green: 58/58 total (9 new) · mutations killed: 5/5 (one after adding a case)_

## Verdict

The batch cursor works and resume is exact. Promotion grade: **Adopt**.

Two things the prototype settled that the design left implicit, both cheap and
both load-bearing:

**1. `remaining` belongs in the cursor record.** The startup report has to say
how much is left, and re-enumerating every interrupted job's source at startup
would mean walking remote trees before the user has asked for anything. Carrying
`remaining` in the record makes the report O(1) per job. The record stays small,
so the flat-cost property is untouched.

**2. Clearing a cursor is a `remove()`, not a write of `null`.** Writing a
tombstone leaves a file that `load()` must then interpret, and it costs an
extra write per completed job. Removal makes "no cursor" and "job finished"
the same observable fact.

## The mutation that survived, and the case it exposed

M5 — *clear the cursor even when cancelled* — survived the first pass.

The reason is a real gap in coverage, not a weak mutation. Early cancellation
exits at the **in-loop** abort check and never reaches the post-loop code, so
every existing cancellation test took that path. The other path is a job whose
abort lands **during its final batch**: the loop runs to completion and only
then sees the abort. A cursor cleared there makes the job silently unresumable —
the worst possible failure for this rung, since the report at startup would
never mention it.

A test now cancels from inside the last entry's write. M5 dies.

## Acceptance criteria, as tested

1. The cursor is written after **every** batch — 20 entries at `batchSize: 4`
   produces exactly 5 cursor writes, counted at the `FilesApi`.
2. **Cost is flat**: doubling the entry count at `batchSize: 1` less than
   triples the bytes written. A growing completed-list would be quadratic.
3. The record holds `lastCompletedBatch`, `cursorPath`, `remaining` and the
   spec needed to re-enqueue.
4. Skipped and failed entries go to `errors.json`, which a cursor cannot
   express; a skipped entry does not fail the job.
5. Re-enqueue copies every remaining entry **exactly once** — 20 files total, no
   duplicates, nothing already done recopied.
6. Cancellation during the final batch preserves the cursor.
7. Enumeration is **reproducible**: two runs walk the identical order, which is
   why a path comparison against `cursorPath` is sufficient and no list of
   completed files is needed.
8. Interrupted jobs are reported at startup with an accurate remaining count.
9. A storage that cannot be re-acquired (`auth expired`) fails the resumed job
   **reportably**, and the cursor survives so it can be retried later.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | cursor saved once at the end instead of per batch | 6 |
| M2 | resume ignores the cursor and recopies everything | 1 |
| M3 | `errors.json` never written | 1 |
| M4 | cursor kept after a completed job | 1 |
| M5 | cursor cleared even when cancelled | 1 (after adding the final-batch case) |

## Code

### `src/core/checkpoints.ts`

```ts
import type { FilesApi } from "@statewalker/webrun-files";

export interface Cursor {
  lastCompletedBatch: number;
  cursorPath: string;
  /** Carried in the record so a startup report costs no re-enumeration. */
  remaining: number;
  spec: {
    operation: "copy" | "move";
    source: { uri: string };
    target: { uri: string; path: string };
    roots: string[];
    batchSize: number;
  };
}

export interface JobError { path: string; reason: "skipped" | "failed"; message?: string }
export interface InterruptedReport { jobId: string; remaining: number; cursor: Cursor }

const encode = (value: unknown) => [new TextEncoder().encode(JSON.stringify(value))];

async function readJson<T>(api: FilesApi, path: string): Promise<T | undefined> {
  if (!(await api.exists(path))) return undefined;
  let text = "";
  for await (const chunk of api.read(path)) text += new TextDecoder().decode(chunk);
  return text ? (JSON.parse(text) as T) : undefined;
}

/**
 * P4 — a BATCH CURSOR, not a list of completed files.
 *
 * `FilesApi.write()` has no append, so a growing completed-list must be
 * rewritten on every flush: O(n²) bytes, minutes of I/O on a 100k-file copy,
 * and flushing rarely is exactly when the most work is lost. The cursor is one
 * small record rewritten after EVERY batch, which is what makes resume accurate
 * rather than approximate. Skipped and failed entries are not expressible as a
 * cursor, so they go in a small errors file beside it.
 *
 * Lives in a host-provided FilesApi that may be a different instance from any
 * storage in the job.
 */
export class CheckpointStore {
  constructor(private readonly _api: FilesApi, private readonly _root = "/jobs") {}

  private _cursorPath(jobId: string) { return `${this._root}/${jobId}/cursor.json`; }
  private _errorsPath(jobId: string) { return `${this._root}/${jobId}/errors.json`; }

  async save(jobId: string, cursor: Cursor): Promise<void> {
    await this._api.write(this._cursorPath(jobId), encode(cursor));
  }

  load(jobId: string): Promise<Cursor | undefined> {
    return readJson<Cursor>(this._api, this._cursorPath(jobId));
  }

  async recordErrors(jobId: string, errors: JobError[]): Promise<void> {
    if (errors.length === 0) return;
    await this._api.write(this._errorsPath(jobId), encode(errors));
  }

  async errors(jobId: string): Promise<JobError[]> {
    return (await readJson<JobError[]>(this._api, this._errorsPath(jobId))) ?? [];
  }

  /** A completed job leaves nothing behind. */
  async clear(jobId: string): Promise<void> {
    await this._api.remove(this._cursorPath(jobId));
  }

  /** v1 resume: report interrupted jobs at startup, one click re-enqueues. */
  async listInterrupted(): Promise<InterruptedReport[]> {
    const reports: InterruptedReport[] = [];
    for await (const entry of this._api.list(this._root)) {
      if (entry.kind !== "directory") continue;
      const cursor = await this.load(entry.name);
      if (!cursor) continue;
      reports.push({ jobId: entry.name, remaining: cursor.remaining, cursor });
    }
    return reports;
  }
}
```

### `src/core/copy-job.ts` — the P4 additions

```ts
  checkpoints?: CheckpointStore;
  /** Re-enqueue of an interrupted job: entries before its cursor are skipped. */
  resumeFrom?: string;
  shouldSkip?(path: string): boolean;
```

```ts
    const all = await enumerate(source.api, spec.roots);
    // Resume skips what the cursor records as done. Because enumeration is
    // deterministically sorted, run N+1 walks the same order as run N, so a
    // path comparison is enough — no list of completed files is needed.
    const resumed = spec.resumeFrom ? await spec.checkpoints?.load(spec.resumeFrom) : undefined;
    const entries = resumed ? all.filter((e) => e.path > resumed.cursorPath) : all;
```

```ts
      const skipped = batch.filter((e) => spec.shouldSkip?.(e.path));
      for (const entry of skipped) errors.push({ path: entry.path, reason: "skipped" });
      const doable = batch.filter((e) => !spec.shouldSkip?.(e.path));

      await Promise.all(doable.map((entry) => transfer(spec, entry, sameStorage)));

      job.completed += batch.length;
      job.notify();

      // The batch is the checkpoint barrier: the cursor is rewritten after
      // every batch, so a crash costs one batch, never a flush interval.
      await spec.checkpoints?.save(job.id, {
        lastCompletedBatch: Math.floor(i / spec.batchSize),
        cursorPath: batch[batch.length - 1].path,
        remaining: entries.length - job.completed,
        spec: { /* operation, source.uri, target.uri + path, roots, batchSize */ },
      });
      await yieldControl();
    }
    await spec.checkpoints?.recordErrors(job.id, errors);
    if (job.signal.aborted) return job.settle("cancelled");
    await spec.checkpoints?.clear(job.id);
    job.settle("done");
```

Suite: `test/p4-checkpoint-resume.test.ts`, with a `CountingFilesApi` that
totals bytes written so the flat-cost claim is **measured**, not asserted.

## Still open, as file 14 predicted

Retention policy for failed jobs' checkpoint files, and whether a cancelled copy
cleans up already-copied entries or only reports the boundary. Nothing in this
rung forces either; both remain additive.

