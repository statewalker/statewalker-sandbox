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

export interface JobError {
  path: string;
  reason: "skipped" | "failed";
  message?: string;
}
export interface InterruptedReport {
  jobId: string;
  remaining: number;
  cursor: Cursor;
}

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
  constructor(
    private readonly _api: FilesApi,
    private readonly _root = "/jobs",
  ) {}

  private _cursorPath(jobId: string) {
    return `${this._root}/${jobId}/cursor.json`;
  }

  private _errorsPath(jobId: string) {
    return `${this._root}/${jobId}/errors.json`;
  }

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

  /**
   * Explicit discard. Removes the cursor AND `errors.json` — a re-enqueued job
   * that inherited stale skips would silently re-apply an answer the user gave
   * to a different run.
   *
   * There is no age-based expiry: a resumable job is a promise to the user and
   * time does not revoke it. The case an age rule would fire on is a
   * long-abandoned large transfer, which is exactly the case worth keeping.
   */
  async discard(jobId: string): Promise<void> {
    await this._api.remove(this._cursorPath(jobId));
    await this._api.remove(this._errorsPath(jobId));
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

  /**
   * Removes only the records whose job finished while the startup report was
   * open — `remaining === 0`. Never prunes on age.
   */
  async pruneCompleted(): Promise<string[]> {
    const pruned: string[] = [];
    for (const report of await this.listInterrupted()) {
      if (report.remaining !== 0) continue;
      await this.discard(report.jobId);
      pruned.push(report.jobId);
    }
    return pruned;
  }
}
