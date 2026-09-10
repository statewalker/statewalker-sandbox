import { type FileRef, JobModel, runCopyJob } from "@fm/core";
import type { Command, Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import type { Invalidation } from "./change-notifier.js";
import { CORE_PRIORITY, overridden } from "./commands.js";
import { filesCopy, filesMove, uiShowJob } from "./declarations.js";

type CopyCommand = Command<
  { files: FileRef[]; target: { storage: string; path: string } },
  { jobId: string }
>;

let seq = 0;

export class JobsController {
  private readonly _jobs = new Map<string, JobModel>();
  private readonly _disposers: (() => void)[] = [];
  private _lastJobId?: string;

  constructor(
    private readonly _commands: Commands,
    private readonly _resolve: (storage: string) => FilesApi,
    private readonly _onChange: (change: Invalidation) => void,
  ) {}

  activate(): void {
    // The core registers its own handlers at NEGATIVE priority: a host
    // overrides any of them simply by listening at priority 0.
    for (const [decl, operation] of [
      [filesCopy, "copy"],
      [filesMove, "move"],
    ] as const) {
      this._disposers.push(
        this._commands.listen(
          decl,
          (cmd) => {
            const job = new JobModel(`job-${++seq}`);
            job.operation = operation;
            this._jobs.set(job.id, job);
            this._lastJobId = job.id;
            this._start(cmd, job, operation);
            // Answered with an ALREADY-RESOLVED promise, so which listener's
            // answer reaches the caller is decided by dispatch order — which is
            // what priority means. Deferring the answer instead would make the
            // core win from any priority, and the override would stop being
            // observable at all.
            return Promise.resolve({ jobId: job.id });
          },
          { priority: CORE_PRIORITY },
        ),
      );
    }
  }

  /**
   * The work, not the answer. The bus claims on a returned promise but settles
   * only when it resolves, so at the moment this listener runs a higher-priority
   * host handler may have claimed the command while `settled` is still false.
   * One yield puts this after every listener's settle, and the check is what
   * makes "a host handler at priority 0 overrides the core's at -1" mean *the
   * core did no work* rather than *the core lost the race to answer*.
   */
  private async _start(cmd: CopyCommand, job: JobModel, operation: "copy" | "move"): Promise<void> {
    if (await overridden(cmd)) {
      // Somebody else answered. Settling the stillborn job keeps `done`
      // resolvable for anyone holding it.
      job.settle("cancelled");
      return;
    }

    const { files, target } = cmd.payload;
    const sourceStorage = files[0]?.storage ?? target.storage;
    // The live progress model crosses the boundary as a command payload.
    this._commands.call(uiShowJob, job);

    void runCopyJob({
      operation,
      source: { uri: sourceStorage, api: this._resolve(sourceStorage) },
      target: { uri: target.storage, api: this._resolve(target.storage), path: target.path },
      // A selection is whatever the user highlighted: the roots are file paths
      // as often as directories, which is what C0's bug 1 was about.
      roots: files.map((ref) => ref.path),
      batchSize: 8,
      job,
      // The TARGET path — change notification needs the end that was written —
      // and the originating job id, which is what lets the panel re-pair a
      // move's two ends and decorate the rows a job is working on.
      onWritten: (targetPath) =>
        this._onChange({
          storage: target.storage,
          path: targetPath,
          kind: "created",
          jobId: job.id,
        }),
      // A move removes its sources as it goes, and the panel showing them is
      // the one that needs to know: that is the confusing case the per-row
      // marking exists for. Only a move reports a "removed" phase at all, so no
      // operation check is needed here — and one would be untestable.
      onEntry: (path, phase) => {
        if (phase !== "removed") return;
        this._onChange({ storage: sourceStorage, path, kind: "removed", jobId: job.id });
      },
    });
  }

  get(id: string): JobModel {
    const job = this._jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }

  lastJobId(): string | undefined {
    return this._lastJobId;
  }

  dispose(): void {
    for (const off of this._disposers) off();
  }
}
