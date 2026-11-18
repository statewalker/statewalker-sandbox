import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { isSafeId } from "./ids.ts";
import { createJobsMcpHandler } from "./mcp.ts";
import {
  type ByteInput,
  type JobManager,
  type JobMessage,
  type JobStatus,
  JobsError,
  type Json,
  type TaskRegistry,
} from "./types.ts";

/**
 * The HTTP face of any JobManager, as a Hono app. It uses only Web-standard APIs (Request,
 * Response, ReadableStream), so the same app runs under Node (see `serve`), Bun, Deno or a Worker.
 *
 *   GET    /tasks                 registered tasks
 *   PUT    /tasks/:name           upload a task { ext, script, cleanup? } -> 201 (needs `registry`)
 *   DELETE /tasks/:name           remove an uploaded task (needs `registry`)
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
 *   *      /mcp                   MCP (Streamable HTTP), see `createJobsMcpHandler`
 *
 * Errors: `{ error: { code, message } }` with 400 (invalid_params), 403 (task_upload_disabled),
 * 404 (unknown_task, unknown_job, not_found), 405 (method_not_allowed) or 500 (internal).
 */
export type JobsAppOptions = {
  /** Path prefix the routes live under, e.g. "/api". URLs in responses include it. */
  basePath?: string;
  /** Interval of SSE keep-alive comments. Default 15 s. */
  keepAliveMs?: number;
  /** Accept task uploads into this registry. Without one, upload and removal answer 403. */
  registry?: TaskRegistry;
  /** Serve MCP at `<basePath>/mcp`. Default true. */
  mcp?: boolean;
  /** Send CORS headers for these origins (`"*"` for any). No CORS headers when omitted. */
  cors?: { origin: string | string[] };
};

/** Options of `createJobsHandler`: the same as the app's. */
export type JobsHandlerOptions = JobsAppOptions;

export type JobsHandler = (request: Request) => Promise<Response>;

const STATUSES: JobStatus[] = ["pending", "running", "done", "error", "interrupted"];

/** Headers an MCP client (and the REST API's SSE resume) sends, and the ones it must read. */
const CORS_ALLOW_HEADERS = [
  "content-type",
  "authorization",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
];
const CORS_EXPOSE_HEADERS = ["location", "mcp-session-id", "mcp-protocol-version"];

export function createJobsApp(manager: JobManager, options: JobsAppOptions = {}): Hono {
  const basePath = (options.basePath ?? "").replace(/\/$/, "");
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const { registry } = options;
  const app = basePath ? new Hono().basePath(basePath) : new Hono();

  if (options.cors) {
    app.use(
      "*",
      cors({
        origin: options.cors.origin,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: CORS_ALLOW_HEADERS,
        exposeHeaders: CORS_EXPOSE_HEADERS,
      }),
    );
  }

  app.get("/tasks", async (c) => c.json(await manager.tasks()));
  app.all("/tasks", notAllowed);

  app.put("/tasks/:name", async (c) => {
    const body = await readJson(c);
    const upload = {
      name: c.req.param("name"),
      ext: field(body, "ext"),
      script: field(body, "script"),
      cleanup: body.cleanup === undefined ? undefined : field(body, "cleanup"),
    };
    return c.json(await uploads(registry).add(upload), 201);
  });
  app.delete("/tasks/:name", async (c) => {
    const name = c.req.param("name");
    await uploads(registry).remove(name);
    return c.json({ removed: name });
  });
  app.all("/tasks/:name", notAllowed);

  app.post("/tasks/:task/jobs", async (c) => {
    const { params, input } = await readSubmission(c.req.raw);
    const jobId = await manager.start(c.req.param("task"), params, input);
    const statusUrl = `${basePath}/jobs/${jobId}`;
    c.header("location", statusUrl);
    return c.json(
      { jobId, statusUrl, logsUrl: `${statusUrl}/logs`, eventsUrl: `${statusUrl}/events` },
      202,
    );
  });
  app.all("/tasks/:task/jobs", notAllowed);

  app.get("/jobs", async (c) => {
    const status = c.req
      .query("status")
      ?.split(",")
      .filter((s): s is JobStatus => STATUSES.includes(s as JobStatus));
    const jobs = [];
    for await (const info of manager.list({ status, task: c.req.query("task") })) jobs.push(info);
    jobs.sort((a, b) => a.created - b.created);
    return c.json(jobs);
  });
  app.all("/jobs", notAllowed);

  app.post("/cleanup", async (c) =>
    c.json(await manager.cleanup(stampParam(c.req.query("before") ?? null))),
  );
  app.all("/cleanup", notAllowed);

  app.get("/jobs/:id", async (c) => c.json(await manager.info(jobId(c))));
  app.delete("/jobs/:id", async (c) => {
    const id = jobId(c);
    return c.json({ id, status: await manager.interrupt(id) });
  });
  app.all("/jobs/:id", notAllowed);

  app.get("/jobs/:id/logs", async (c) => {
    const id = jobId(c);
    const since = stampParam(c.req.query("since") ?? null);
    await manager.info(id); // 404 before the stream starts
    const follow = ["1", "true"].includes(c.req.query("follow") ?? "");
    return stream(
      (signal) => manager.logs(id, since, { follow, signal }),
      (m) => `${JSON.stringify(m)}\n`,
      "application/x-ndjson",
      c.req.raw.signal,
    );
  });
  app.all("/jobs/:id/logs", notAllowed);

  app.get("/jobs/:id/events", async (c) => {
    const id = jobId(c);
    const since = stampParam(c.req.header("last-event-id") ?? c.req.query("since") ?? null);
    await manager.info(id);
    return stream(
      (signal) => manager.logs(id, since, { follow: true, signal }),
      (m) => `id: ${m.stamp}\ndata: ${JSON.stringify(m)}\n\n`,
      "text/event-stream",
      c.req.raw.signal,
      keepAliveMs,
    );
  });
  app.all("/jobs/:id/events", notAllowed);

  if (options.mcp ?? true) {
    const mcp = createJobsMcpHandler(manager, { registry });
    app.all("/mcp", (c) => mcp.fetch(c.req.raw));
  }

  app.notFound((c) => c.json(errorBody("not_found", "No such route"), 404));
  app.onError((e, c) => {
    if (e instanceof JobsError) return c.json(errorBody(e.code, e.message), statusOf(e));
    return c.json(errorBody("internal", e instanceof Error ? e.message : String(e)), 500);
  });
  return app;
}

/** The app as a plain fetch handler (`Request -> Response`). */
export function createJobsHandler(manager: JobManager, options: JobsAppOptions = {}): JobsHandler {
  const app = createJobsApp(manager, options);
  return async (request) => app.fetch(request);
}

function statusOf(e: JobsError): 400 | 403 | 404 {
  if (e.code === "invalid_params") return 400;
  if (e.code === "task_upload_disabled") return 403;
  return 404;
}

function uploads(registry: TaskRegistry | undefined): TaskRegistry {
  if (registry) return registry;
  throw new JobsError("task_upload_disabled", "This server does not accept task uploads");
}

function jobId(c: Context): string {
  const id = c.req.param("id") ?? "";
  if (!isSafeId(id)) throw new JobsError("unknown_job", `Unknown job: ${id}`);
  return id;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body))
      return body as Record<string, unknown>;
  } catch {}
  throw new JobsError("invalid_params", "the body must be a JSON object");
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") throw new JobsError("invalid_params", `${name} must be a string`);
  return value;
}

async function readSubmission(request: Request): Promise<{ params: Json; input?: ByteInput }> {
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
  const query = new URL(request.url).searchParams.get("params");
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

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function notAllowed(c: Context): Response {
  return c.json(errorBody("method_not_allowed", "Method not allowed"), 405);
}
