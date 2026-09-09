import { type FileRef, JobModel, runCopyJob } from "@fm/core";
import type { Command, Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import { filesCopy, uiShowJob } from "./declarations.js";

let seq = 0;

export class JobsController {
  private readonly _jobs = new Map<string, JobModel>();
  private readonly _disposers: (() => void)[] = [];
  private _lastJobId?: string;

  constructor(
    private readonly _commands: Commands,
    private readonly _resolve: (storage: string) => FilesApi,
    private readonly _onChange: (storage: string, path: string) => void,
  ) {}

  activate(): void {
    // The core registers its own handler at NEGATIVE priority: a host
    // overrides it simply by listening at priority 0.
    this._disposers.push(
      this._commands.listen(
        filesCopy,
        (cmd) => {
          // The job id is minted synchronously: `files:copy` answers with one
          // before any walking happens.
          const job = new JobModel(`job-${++seq}`);
          this._jobs.set(job.id, job);
          this._lastJobId = job.id;
          return this._run(cmd, job);
        },
        { priority: -1 },
      ),
    );
  }

  /**
   * The bus claims on a returned promise but only settles when it resolves, so
   * a higher-priority host listener has claimed the command yet left `settled`
   * false while this listener is still being called. Yielding once and checking
   * `settled` is what makes "a host handler at priority 0 overrides the core's"
   * mean *the core did no work*, rather than *the core lost the race to answer*.
   */
  private async _run(
    cmd: Command<
      { files: FileRef[]; target: { storage: string; path: string } },
      { jobId: string }
    >,
    job: JobModel,
  ): Promise<{ jobId: string }> {
    await Promise.resolve();
    if (cmd.settled) {
      job.settle("cancelled");
      return { jobId: job.id };
    }

    const { files, target } = cmd.payload;
    // The live progress model crosses the boundary as a command payload.
    this._commands.call(uiShowJob, job);

    void runCopyJob({
      operation: "copy",
      source: { uri: files[0]?.storage ?? target.storage, api: this._resolve(files[0]?.storage ?? target.storage) },
      target: { uri: target.storage, api: this._resolve(target.storage), path: target.path },
      roots: files.map((ref) => ref.path),
      batchSize: 8,
      job,
      onWritten: (targetPath) => this._onChange(target.storage, targetPath),
    });

    return { jobId: job.id };
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
