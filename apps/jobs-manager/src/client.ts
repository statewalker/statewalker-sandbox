import { lines } from "./jsonl.ts";
import {
  type ByteInput,
  type CleanupResult,
  type JobId,
  type JobInfo,
  type JobManager,
  type JobMessage,
  type JobStatus,
  JobsError,
  type JobTimeStamp,
  type Json,
  type ListFilter,
  type LogsOptions,
  type TaskInfo,
} from "./types.ts";

/** Raised when the server cannot be reached or answers something that is not the jobs API. */
export class JobsClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JobsClientError";
  }
}

const SERVER_CODES = new Set(["unknown_task", "unknown_job", "invalid_params"]);

/**
 * The JobManager interface over the REST API (`createJobsHandler`). Anything written against
 * `JobManager` works the same in process and against a remote server.
 */
export class JobsClient implements JobManager {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async tasks(): Promise<TaskInfo[]> {
    return (await this.#json("GET", "/tasks")) as TaskInfo[];
  }

  async start(task: string, params: Json = null, input?: ByteInput): Promise<JobId> {
    const path = `/tasks/${encodeURIComponent(task)}/jobs`;
    const body = input
      ? await this.#json("POST", `${path}?params=${encodeURIComponent(JSON.stringify(params))}`, {
          headers: { "content-type": "application/octet-stream" },
          body: toStream(input),
          duplex: "half",
        })
      : await this.#json("POST", path, {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        });
    return (body as { jobId: JobId }).jobId;
  }

  async *logs(
    id: JobId,
    since: JobTimeStamp = 0,
    options: LogsOptions = {},
  ): AsyncGenerator<JobMessage> {
    const { follow = true, signal } = options;
    const query = `?since=${since}&follow=${follow ? 1 : 0}`;
    // Aborting ends the generator quietly, also before the server has answered (`wait --timeout`).
    let response: Response;
    try {
      response = await this.#fetch("GET", `/jobs/${encodeURIComponent(id)}/logs${query}`, {
        signal,
      });
    } catch (e) {
      if (signal?.aborted) return;
      throw e;
    }
    if (!response.body) return;
    try {
      for await (const line of lines(response.body as unknown as AsyncIterable<Uint8Array>)) {
        if (line) yield JSON.parse(line) as JobMessage;
      }
    } catch (e) {
      if (!signal?.aborted) throw e;
    }
  }

  async status(id: JobId): Promise<JobStatus> {
    return (await this.info(id)).status;
  }

  async info(id: JobId): Promise<JobInfo> {
    return (await this.#json("GET", `/jobs/${encodeURIComponent(id)}`)) as JobInfo;
  }

  async interrupt(id: JobId): Promise<JobStatus> {
    const body = await this.#json("DELETE", `/jobs/${encodeURIComponent(id)}`);
    return (body as { status: JobStatus }).status;
  }

  async *list(filter: ListFilter = {}): AsyncGenerator<JobInfo> {
    const query = new URLSearchParams();
    if (filter.status !== undefined) query.set("status", [filter.status].flat().join(","));
    if (filter.task !== undefined) query.set("task", filter.task);
    const qs = query.size > 0 ? `?${query}` : "";
    for (const info of (await this.#json("GET", `/jobs${qs}`)) as JobInfo[]) yield info;
  }

  async cleanup(before?: JobTimeStamp): Promise<CleanupResult> {
    const qs = before === undefined ? "" : `?before=${before}`;
    return (await this.#json("POST", `/cleanup${qs}`)) as CleanupResult;
  }

  async #json(method: string, path: string, init: RequestInit & { duplex?: "half" } = {}) {
    const response = await this.#fetch(method, path, init);
    return (await response.json()) as unknown;
  }

  /** Fetches, turning transport failures and error answers into JobsClientError / JobsError. */
  async #fetch(method: string, path: string, init: RequestInit & { duplex?: "half" } = {}) {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, method });
    } catch (e) {
      if (init.signal?.aborted) throw e;
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new JobsClientError(
        `cannot reach ${this.baseUrl}: ${cause?.code ?? cause?.message ?? String(e)}`,
        { cause: e },
      );
    }
    if (response.ok) return response;
    let error: { code?: string; message?: string } | undefined;
    try {
      error = ((await response.json()) as { error?: typeof error }).error;
    } catch {
      // not a JSON error body
    }
    if (error?.code && SERVER_CODES.has(error.code)) {
      throw new JobsError(error.code as JobsError["code"], error.message ?? error.code);
    }
    throw new JobsClientError(
      `${method} ${path} failed with ${response.status}: ${error?.message ?? response.statusText}`,
    );
  }
}

/** ReadableStream.from (Node 20+, modern browsers); not yet in the DOM typings. */
function toStream(input: ByteInput): BodyInit {
  const RS = ReadableStream as unknown as { from(i: ByteInput): ReadableStream<Uint8Array> };
  return RS.from(input) as unknown as BodyInit;
}
