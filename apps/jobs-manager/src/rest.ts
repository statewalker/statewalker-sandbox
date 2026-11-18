import { isSafeId } from "./file-store.ts";
import {
  type ByteInput,
  type JobManager,
  type JobMessage,
  type JobStatus,
  JobsError,
  type Json,
} from "./types.ts";

/**
 * REST adapter over any JobManager, as a fetch-style handler (`Request -> Response`), so it runs
 * under Node (see `serve`), Bun, Deno or a Worker unchanged.
 *
 *   GET    /tasks                 registered tasks
 *   POST   /tasks/:task/jobs      start a job -> 202 { jobId, statusUrl, logsUrl, eventsUrl }
 *                                   application/json     body = params, no input
 *                                   multipart/form-data  field `params` (JSON) + file `input`
 *                                   anything else        body = input stream, `?params=<json>`
 *   GET    /jobs                  JobInfo[]; ?status=a,b &task=name
 *   GET    /jobs/:id              JobInfo
 *   GET    /jobs/:id/logs         application/x-ndjson; ?since=<stamp> &follow=1
 *   GET    /jobs/:id/events       text/event-stream, follows to the end; resume with Last-Event-ID or ?since
 *   DELETE /jobs/:id              interrupt -> { id, status }
 *   POST   /cleanup               ?before=<stamp> -> { removed, failed }
 *
 * Errors: `{ error: { code, message } }` with 400 (invalid_params), 404 (unknown_task, unknown_job,
 * not_found), 405 (method_not_allowed) or 500 (internal).
 */
export type JobsHandlerOptions = {
  /** Path prefix the routes live under, e.g. "/api". URLs in responses include it. */
  basePath?: string;
  /** Interval of SSE keep-alive comments. Default 15 s. */
  keepAliveMs?: number;
};

export type JobsHandler = (request: Request) => Promise<Response>;

const STATUSES: JobStatus[] = ["pending", "running", "done", "error", "interrupted"];

export function createJobsHandler(
  manager: JobManager,
  options: JobsHandlerOptions = {},
): JobsHandler {
  const basePath = (options.basePath ?? "").replace(/\/$/, "");
  const keepAliveMs = options.keepAliveMs ?? 15_000;

  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(basePath)) return error(404, "not_found", "No such route");
    const parts = url.pathname
      .slice(basePath.length)
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const method = request.method;
    try {
      // /tasks
      if (parts.length === 1 && parts[0] === "tasks") {
        return method === "GET" ? json(200, manager.tasks()) : notAllowed();
      }
      // /tasks/:task/jobs
      if (parts.length === 3 && parts[0] === "tasks" && parts[2] === "jobs") {
        if (method !== "POST") return notAllowed();
        const { params, input } = await readSubmission(request, url);
        const jobId = await manager.start(parts[1], params, input);
        const statusUrl = `${basePath}/jobs/${jobId}`;
        return json(
          202,
          { jobId, statusUrl, logsUrl: `${statusUrl}/logs`, eventsUrl: `${statusUrl}/events` },
          { location: statusUrl },
        );
      }
      // /jobs
      if (parts.length === 1 && parts[0] === "jobs") {
        if (method !== "GET") return notAllowed();
        const status = url.searchParams
          .get("status")
          ?.split(",")
          .filter((s): s is JobStatus => STATUSES.includes(s as JobStatus));
        const task = url.searchParams.get("task") ?? undefined;
        const jobs = [];
        for await (const info of manager.list({ status, task })) jobs.push(info);
        jobs.sort((a, b) => a.created - b.created);
        return json(200, jobs);
      }
      // /cleanup
      if (parts.length === 1 && parts[0] === "cleanup") {
        if (method !== "POST") return notAllowed();
        return json(200, await manager.cleanup(stampParam(url.searchParams.get("before"))));
      }
      // /jobs/:id[/logs|/events]
      if (parts[0] === "jobs" && (parts.length === 2 || parts.length === 3)) {
        const id = parts[1];
        if (!isSafeId(id)) throw new JobsError("unknown_job", `Unknown job: ${id}`);
        const sub = parts[2];
        if (sub === undefined) {
          if (method === "GET") return json(200, await manager.info(id));
          if (method === "DELETE") return json(200, { id, status: await manager.interrupt(id) });
          return notAllowed();
        }
        if (method !== "GET") return notAllowed();
        if (sub === "logs") {
          const since = stampParam(url.searchParams.get("since"));
          await manager.info(id); // 404 before the stream starts
          const follow = ["1", "true"].includes(url.searchParams.get("follow") ?? "");
          return stream(
            (signal) => manager.logs(id, since, { follow, signal }),
            (m) => `${JSON.stringify(m)}\n`,
            "application/x-ndjson",
            request.signal,
          );
        }
        if (sub === "events") {
          const since = stampParam(
            request.headers.get("last-event-id") ?? url.searchParams.get("since"),
          );
          await manager.info(id);
          return stream(
            (signal) => manager.logs(id, since, { follow: true, signal }),
            (m) => `id: ${m.stamp}\ndata: ${JSON.stringify(m)}\n\n`,
            "text/event-stream",
            request.signal,
            keepAliveMs,
          );
        }
      }
      return error(404, "not_found", "No such route");
    } catch (e) {
      if (e instanceof JobsError)
        return error(e.code === "invalid_params" ? 400 : 404, e.code, e.message);
      return error(500, "internal", e instanceof Error ? e.message : String(e));
    }
  };
}

async function readSubmission(
  request: Request,
  url: URL,
): Promise<{ params: Json; input?: ByteInput }> {
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("application/json")) {
    const text = await request.text();
    return { params: text.trim() ? parseParams(text) : null };
  }
  if (type.startsWith("multipart/form-data")) {
    const form = await request.formData();
    const params = form.get("params");
    const input = form.get("input");
    return {
      params: typeof params === "string" && params.trim() ? parseParams(params) : null,
      input:
        input instanceof Blob
          ? (input.stream() as unknown as AsyncIterable<Uint8Array>)
          : undefined,
    };
  }
  const query = url.searchParams.get("params");
  return {
    params: query ? parseParams(query) : null,
    input: request.body ? (request.body as unknown as AsyncIterable<Uint8Array>) : undefined,
  };
}

/** A stamp from a query or header; anything but a finite number is rejected, never read as "all". */
function stampParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const stamp = Number(value);
  if (!Number.isFinite(stamp)) throw new JobsError("invalid_params", `Not a timestamp: ${value}`);
  return stamp;
}

function parseParams(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new JobsError("invalid_params", "params must be valid JSON");
  }
}

/** Serialises a message generator into a streamed response; stops it when the client goes away. */
function stream(
  open: (signal: AbortSignal) => AsyncGenerator<JobMessage>,
  format: (m: JobMessage) => string,
  contentType: string,
  requestSignal: AbortSignal,
  keepAliveMs?: number,
): Response {
  const abort = new AbortController();
  const stop = () => abort.abort();
  requestSignal.addEventListener("abort", stop);
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (keepAliveMs) {
        timer = setInterval(
          () => controller.enqueue(encoder.encode(": keep-alive\n\n")),
          keepAliveMs,
        );
      }
      void (async () => {
        try {
          for await (const message of open(abort.signal))
            controller.enqueue(encoder.encode(format(message)));
          controller.close();
        } catch (e) {
          if (!abort.signal.aborted) controller.error(e);
        } finally {
          clearInterval(timer);
          requestSignal.removeEventListener("abort", stop);
        }
      })();
    },
    cancel() {
      clearInterval(timer);
      stop();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

function notAllowed(): Response {
  return error(405, "method_not_allowed", "Method not allowed");
}
