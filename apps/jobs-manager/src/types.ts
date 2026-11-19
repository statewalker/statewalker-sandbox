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
 * Wall-clock milliseconds since the Unix epoch (`Date.now()`); messages recorded in the same
 * millisecond get microsecond fractions.
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
  /** JSON Schemas for the job's params, input, output and error lines; see `TaskSchema`. */
  schema?: TaskSchema;
};

/** A JSON Schema (draft 2020-12), as read by `z.fromJSONSchema`. */
export type JsonSchema = { [key: string]: Json } | boolean;

/**
 * What a task accepts and produces, read from `<task>.schema.json`. Every part is optional; a
 * missing part is not checked. Checks never change values.
 *
 * - `params`  the job's params; a mismatch rejects `start` with `invalid_params`
 * - `body`    the input: a JSON Schema means JSONL, each line checked (a bad line rejects `start`);
 *             `{ contentMediaType }` without `type` means opaque bytes, not checked
 * - `message` each stdout line; a mismatch is recorded as `{ code: "invalid_message", issues, raw }`
 * - `error`   each stderr line; a mismatch is recorded as `{ code: "invalid_error", issues, raw }`
 */
export type TaskSchema = {
  params?: JsonSchema;
  body?: JsonSchema;
  message?: JsonSchema;
  error?: JsonSchema;
};

/** One schema violation: where (a JSON Pointer into the value, `/` for the value itself) and what. */
export type Issue = { path: string; message: string };

export type TaskInfo = { name: string; hasCleanup: boolean };

/** A task sent over the API: the script's source text and the extension that picks its launcher. */
export type TaskUpload = {
  name: string;
  /** Launcher extension without the dot: `sh`, `py`, `js`, `ts`, … */
  ext: string;
  script: string;
  /** Cleanup script source, run with the same launcher. */
  cleanup?: string;
  /** Written as `<name>.schema.json`; refused with `invalid_params` if it does not compile. */
  schema?: TaskSchema;
};

/**
 * Where uploaded tasks go. The REST and MCP adapters accept uploads only when given one, because
 * an uploaded task is code the server runs: anyone who can reach the API can then run commands.
 */
export interface TaskRegistry {
  /** Fails with `invalid_params` for a bad name or extension, or a name already taken. */
  add(task: TaskUpload): Promise<TaskInfo>;
  /** Fails with `unknown_task` when there is no such task. */
  remove(name: string): Promise<void>;
}

export type ByteInput = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/** A file in a job's results folder, as served over HTTP. */
export type OutputFile = { body: ReadableStream<Uint8Array>; size: number; type: string };

/**
 * Read access to the jobs' results folders, for `GET <basePath>/outputs/:jobId/<path>`. An
 * implementation answers `undefined` for anything that is not a file inside that job's own folder:
 * `..`, absolute paths and other jobs' files included.
 */
export interface OutputFiles {
  read(id: JobId, path: string): Promise<OutputFile | undefined>;
}

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
  /** Removes jobs that finished at or before `before` (default: now, to the millisecond), running their cleanup scripts. */
  cleanup(before?: JobTimeStamp): Promise<CleanupResult>;
  tasks(): Promise<TaskInfo[]>;
}

export class JobsError extends Error {
  readonly code: "unknown_task" | "unknown_job" | "invalid_params" | "task_upload_disabled";
  /** The schema violations behind an `invalid_params`, when a task's schema rejected a value. */
  readonly issues?: Issue[];
  constructor(code: JobsError["code"], message: string, issues?: Issue[]) {
    super(message);
    this.name = "JobsError";
    this.code = code;
    if (issues) this.issues = issues;
  }
}
