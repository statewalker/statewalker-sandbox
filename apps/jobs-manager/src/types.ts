/**
 * Public contract of the jobs manager.
 *
 * A *task* is a named script (plus an optional cleanup script). A *job* is one
 * run of a task with JSON parameters and an optional input byte stream. Every
 * line the script writes to stdout is parsed as JSON and recorded as a
 * message; stderr lines are recorded too. Clients read the recorded messages
 * (`logs`) while the job runs and after it has finished.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type JobId = string;

/**
 * Milliseconds since the Unix epoch, with microsecond fractions.
 * Stamps are strictly increasing within one job, so a stamp identifies a
 * message and `logs(id, since)` can resume exactly after it.
 */
export type JobTimeStamp = number;

export type JobStatus = "pending" | "running" | "done" | "error" | "interrupted";

export const TERMINAL_STATUSES: readonly JobStatus[] = ["done", "error", "interrupted"];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * One recorded message. `status` is always the job status at the time the
 * message was recorded; the payload says where the message came from:
 *
 * - `{ status: "pending" }`               job accepted, waiting for a slot
 * - `{ status: "running" }`               process started
 * - `{ status: "running", message }`      one stdout line (parsed JSON, or the raw string)
 * - `{ status: "running", error }`        one stderr line (parsed JSON, or the raw string)
 * - `{ status: "done" }`                  process exited with code 0
 * - `{ status: "error", error }`          process failed: `{ code, exitCode?, signal?, stderr?, message? }`
 * - `{ status: "interrupted", error? }`   interrupted by a client, or found running after a restart
 */
export type JobMessage =
  | { stamp: JobTimeStamp; status: "pending" }
  | { stamp: JobTimeStamp; status: "running"; message?: Json; error?: Json }
  | { stamp: JobTimeStamp; status: "done" }
  | { stamp: JobTimeStamp; status: "error"; error: Json }
  | { stamp: JobTimeStamp; status: "interrupted"; error?: Json };

export type JobInfo = {
  id: JobId;
  task: string;
  params: Json;
  status: JobStatus;
  /** Stamp of the first (`pending`) message. */
  created: JobTimeStamp;
  /** Stamp of the latest status change; for a finished job, when it finished. */
  updated: JobTimeStamp;
  /** Process group id while running (recorded so a restarted manager can stop orphans). */
  pid?: number;
};

export type TaskDefinition = {
  name: string;
  /** Script that runs the job. The launcher is chosen by its extension. */
  script: string;
  /** Optional script that removes the artefacts of a job being cleaned up. */
  cleanup?: string;
  /** Working directory of both scripts. Defaults to the script's directory. */
  cwd?: string;
  /** Extra environment variables for both scripts. */
  env?: Record<string, string>;
};

export type TaskInfo = { name: string; hasCleanup: boolean };

export type ByteInput = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

export type LogsOptions = {
  /** Keep waiting for new messages until the job finishes. Default `true`. */
  follow?: boolean;
  /** Stops a following reader. */
  signal?: AbortSignal;
};

export type ListFilter = { status?: JobStatus | JobStatus[]; task?: string };

export type CleanupResult = {
  removed: JobId[];
  /** Jobs whose cleanup script failed; they are kept so cleanup can be retried. */
  failed: { id: JobId; error: string }[];
};

export interface JobManager {
  /** Records the job, stores its input and queues it. Resolves once the job is `pending`. */
  start(task: string, params?: Json, input?: ByteInput): Promise<JobId>;
  /** Recorded messages with a stamp greater than `since`; follows a live job by default. */
  logs(id: JobId, since?: JobTimeStamp, options?: LogsOptions): AsyncGenerator<JobMessage>;
  status(id: JobId): Promise<JobStatus>;
  info(id: JobId): Promise<JobInfo>;
  /** Stops a pending or running job; resolves with the final status. A finished job is left as is. */
  interrupt(id: JobId): Promise<JobStatus>;
  list(filter?: ListFilter): AsyncGenerator<JobInfo>;
  /** Removes finished jobs that finished before `before` (default: now), running their cleanup scripts. */
  cleanup(before?: JobTimeStamp): Promise<CleanupResult>;
  tasks(): TaskInfo[];
}

export class JobsError extends Error {
  readonly code: "unknown_task" | "unknown_job" | "invalid_params";
  constructor(code: JobsError["code"], message: string) {
    super(message);
    this.name = "JobsError";
    this.code = code;
  }
}
