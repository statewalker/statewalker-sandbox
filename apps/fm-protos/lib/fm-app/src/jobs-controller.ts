import type { Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import { JobModel, runCopyJob } from "@fm/core";
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
          // The P0 fake engine is gone: the controller now drives the real
          // one, with the selection as roots (files or directories alike).
          const job = new JobModel(`job-${++seq}`);
          void runCopyJob({
            operation: "copy",
            source: { uri: cmd.payload.files[0].storage, api: this._resolve(cmd.payload.files[0].storage) },
            target: {
              uri: cmd.payload.target.storage,
              api: this._resolve(cmd.payload.target.storage),
              path: cmd.payload.target.path,
            },
            roots: cmd.payload.files.map((f) => f.path),
            batchSize: 4,
            job,
            onWritten: (targetPath) => this._onChange(cmd.payload.target.storage, targetPath),
          });
          this._jobs.set(job.id, job);
          this._lastJobId = job.id;
          // The live progress model crosses the boundary as a command payload.
          this._commands.call(uiShowJob, job);
          return Promise.resolve({ jobId: job.id });
        },
        { priority: -1 },
      ),
    );
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
