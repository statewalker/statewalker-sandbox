import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import {
  CleanupResult,
  ErrorBody,
  JobInfo,
  JobMessage,
  START_BODY,
  StartResponse,
  TaskInfo,
  TaskUploadBody,
} from "./api-schemas.ts";
import { isSafeId } from "./ids.ts";
import { createJobsMcpHandler } from "./mcp.ts";
import { describeIssues } from "./task-schema.ts";
import {
  type ByteInput,
  type Issue,
  type JobManager,
  JobsError,
  type Json,
  type JobMessage as Message,
  type OutputFiles,
  type JobStatus as Status,
  type TaskRegistry,
  type TaskUpload,
} from "./types.ts";

/**
 * The HTTP face of any JobManager, as a Hono app. It uses only Web-standard APIs (Request,
 * Response, ReadableStream), so the same app runs under Node (see `serve`), Bun, Deno or a Worker.
 * Routes are declared with Zod (`@hono/zod-openapi`): the same schemas validate requests and
 * generate the OpenAPI 3.1 document at `GET <basePath>/openapi.json`.
 *
 *   GET    /openapi.json          the OpenAPI document of this API
 *   GET    /tasks                 registered tasks
 *   PUT    /tasks/:name           upload a task { ext, script, cleanup?, schema? } -> 201 (needs `registry`)
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
 *   GET    /outputs/:id/<path>    a file from the job's results folder (needs `outputs`)
 *   *      /mcp                   MCP (Streamable HTTP), see `createJobsMcpHandler`
 *
 * Errors: `{ error: { code, message, issues? } }` with 400 (invalid_params), 403
 * (task_upload_disabled), 404 (unknown_task, unknown_job, not_found), 405 (method_not_allowed) or
 * 500 (internal). `issues` lists the schema violations behind an invalid_params.
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
  /** Serve the jobs' results folders at `<basePath>/outputs/:jobId/<path>`. No route when omitted. */
  outputs?: OutputFiles;
};

/** Options of `createJobsHandler`: the same as the app's. */
export type JobsHandlerOptions = JobsAppOptions;

export type JobsHandler = (request: Request) => Promise<Response>;

const STATUSES: Status[] = ["pending", "running", "done", "error", "interrupted"];

/** Headers an MCP client (and the REST API's SSE resume) sends, and the ones it must read. */
const CORS_ALLOW_HEADERS = [
  "content-type",
  "authorization",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
];
const CORS_EXPOSE_HEADERS = ["location", "mcp-session-id", "mcp-protocol-version"];

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const ERRORS = {
  400: json(ErrorBody, "invalid_params: the request, or a value the task's schema checks"),
  404: json(ErrorBody, "unknown_task, unknown_job"),
};
const ID = { params: z.object({ id: z.string() }) };
const STAMP = (description: string) => z.string().optional().openapi({ description });

const routes = {
  tasks: createRoute({
    method: "get",
    path: "/tasks",
    summary: "List the tasks",
    responses: { 200: json(TaskInfo.array(), "The registered tasks") },
  }),
  upload: createRoute({
    method: "put",
    path: "/tasks/{name}",
    summary: "Upload a task (only with task upload enabled: the server runs this code)",
    request: {
      params: TaskInfo.pick({ name: true }),
      body: { content: { "application/json": { schema: TaskUploadBody } }, required: true },
    },
    responses: {
      201: json(TaskInfo, "Added"),
      400: ERRORS[400],
      403: json(ErrorBody, "task_upload_disabled"),
    },
  }),
  removeTask: createRoute({
    method: "delete",
    path: "/tasks/{name}",
    summary: "Remove an uploaded task (only with task upload enabled)",
    request: { params: TaskInfo.pick({ name: true }) },
    responses: {
      200: json(z.object({ removed: z.string() }), "Removed"),
      403: json(ErrorBody, "task_upload_disabled"),
      404: ERRORS[404],
    },
  }),
  start: createRoute({
    method: "post",
    path: "/tasks/{task}/jobs",
    summary: "Start a job",
    description:
      "Params and input are checked against the task's schema, if it has one: a mismatch is a 400 with the issues, and no job is created.",
    request: {
      params: z.object({ task: z.string() }),
      query: z.object({
        params: z
          .string()
          .optional()
          .openapi({ description: "Params as JSON, with a raw input body" }),
      }),
      body: { content: START_BODY },
    },
    responses: {
      202: json(StartResponse, "Accepted: the job is pending"),
      400: ERRORS[400],
      404: ERRORS[404],
    },
  }),
  jobs: createRoute({
    method: "get",
    path: "/jobs",
    summary: "List jobs, oldest first",
    request: {
      query: z.object({
        status: z.string().optional().openapi({ description: "Comma-separated statuses" }),
        task: z.string().optional(),
      }),
    },
    responses: { 200: json(JobInfo.array(), "The jobs") },
  }),
  cleanup: createRoute({
    method: "post",
    path: "/cleanup",
    summary: "Remove finished jobs, running their tasks' cleanup scripts",
    request: { query: z.object({ before: STAMP("Epoch ms; default now") }) },
    responses: {
      200: json(CleanupResult, "Removed, and failed (kept for a retry)"),
      400: ERRORS[400],
    },
  }),
  job: createRoute({
    method: "get",
    path: "/jobs/{id}",
    summary: "A job's record",
    request: ID,
    responses: { 200: json(JobInfo, "The job"), 404: ERRORS[404] },
  }),
  interrupt: createRoute({
    method: "delete",
    path: "/jobs/{id}",
    summary: "Interrupt a pending or running job",
    request: ID,
    responses: {
      200: json(JobInfo.pick({ id: true, status: true }), "Its final status"),
      404: ERRORS[404],
    },
  }),
  logs: createRoute({
    method: "get",
    path: "/jobs/{id}/logs",
    summary: "A job's messages as NDJSON",
    request: {
      ...ID,
      query: z.object({
        since: STAMP("Resume after this stamp"),
        follow: z
          .string()
          .optional()
          .openapi({ description: "1 or true: keep streaming until the job ends" }),
      }),
    },
    responses: {
      200: {
        content: { "application/x-ndjson": { schema: JobMessage } },
        description: "One JobMessage per line",
      },
      400: ERRORS[400],
      404: ERRORS[404],
    },
  }),
  events: createRoute({
    method: "get",
    path: "/jobs/{id}/events",
    summary: "A job's messages as server-sent events, to the end",
    request: {
      ...ID,
      query: z.object({ since: STAMP("Resume after this stamp") }),
      headers: z.object({
        "last-event-id": z.string().optional().openapi({ description: "Resume after this stamp" }),
      }),
    },
    responses: {
      200: {
        content: { "text/event-stream": { schema: JobMessage } },
        description: "`id: <stamp>` and `data: <JobMessage>` per event",
      },
      400: ERRORS[400],
      404: ERRORS[404],
    },
  }),
};

export function createJobsApp(manager: JobManager, options: JobsAppOptions = {}): OpenAPIHono {
  const basePath = (options.basePath ?? "").replace(/\/$/, "");
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const { registry, outputs } = options;
  const root = new OpenAPIHono({
    // A request the route's schemas reject keeps the API's error shape.
    defaultHook: (result) => {
      if (!result.success) throw invalidParams(result.target, result.error.issues);
    },
  });
  const app = basePath ? root.basePath(basePath) : root;

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

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Jobs manager",
      version: "0.0.0",
      description:
        "Run named tasks as jobs, follow their messages, fetch their results. Each task may declare JSON Schemas for its params, input and output (see TaskSchema).",
    },
  });

  app.openapi(routes.tasks, async (c) => c.json(await manager.tasks(), 200));
  app.all("/tasks", notAllowed);

  // Validated here rather than by the adapter: the registry check comes first (403 whatever the
  // body), and a JSON body is accepted under any content type, as `fetch` sends text/plain.
  app.openAPIRegistry.registerPath(routes.upload);
  app.put("/tasks/:name", async (c) => {
    const target = uploads(registry);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new JobsError("invalid_params", "the body must be a JSON object");
    }
    const parsed = TaskUploadBody.safeParse(body);
    if (!parsed.success) throw invalidParams("body", parsed.error.issues);
    const upload = { name: c.req.param("name"), ...parsed.data } as TaskUpload;
    return c.json(await target.add(upload), 201);
  });
  app.openapi(routes.removeTask, async (c) => {
    const { name } = c.req.valid("param");
    await uploads(registry).remove(name);
    return c.json({ removed: name }, 200);
  });
  app.all("/tasks/:name", notAllowed);

  app.openapi(routes.start, async (c) => {
    const { params, input } = await readSubmission(c.req.raw);
    const jobId = await manager.start(c.req.valid("param").task, params, input);
    const statusUrl = `${basePath}/jobs/${jobId}`;
    c.header("location", statusUrl);
    return c.json(
      { jobId, statusUrl, logsUrl: `${statusUrl}/logs`, eventsUrl: `${statusUrl}/events` },
      202,
    );
  });
  app.all("/tasks/:task/jobs", notAllowed);

  app.openapi(routes.jobs, async (c) => {
    const query = c.req.valid("query");
    const status = query.status
      ?.split(",")
      .filter((s): s is Status => STATUSES.includes(s as Status));
    const jobs: z.infer<typeof JobInfo>[] = [];
    for await (const info of manager.list({ status, task: query.task })) jobs.push(info);
    jobs.sort((a, b) => a.created - b.created);
    return c.json(jobs, 200);
  });
  app.all("/jobs", notAllowed);

  app.openapi(routes.cleanup, async (c) =>
    c.json(await manager.cleanup(stampParam(c.req.query("before") ?? null)), 200),
  );
  app.all("/cleanup", notAllowed);

  app.openapi(routes.job, async (c) => {
    const info: z.infer<typeof JobInfo> = await manager.info(jobId(c));
    return c.json(info, 200);
  });
  app.openapi(routes.interrupt, async (c) => {
    const id = jobId(c);
    return c.json({ id, status: await manager.interrupt(id) }, 200);
  });
  app.all("/jobs/:id", notAllowed);

  app.openapi(routes.logs, (async (c: Context) => {
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
  }) as never);
  app.all("/jobs/:id/logs", notAllowed);

  app.openapi(routes.events, (async (c: Context) => {
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
  }) as never);
  app.all("/jobs/:id/events", notAllowed);

  if (outputs) {
    // Documented by hand: a path of any depth is not expressible as a route parameter.
    app.openAPIRegistry.registerPath({
      method: "get",
      path: "/outputs/{id}/{path}",
      summary: "A file from the job's results folder",
      description:
        "Results a task wrote to JOB_OUTPUT_DIR, at the URL it reported (JOB_OUTPUT_URL + file name). `path` may contain slashes. Only files inside the job's own folder are served.",
      request: {
        params: z.object({ id: z.string(), path: z.string() }),
      },
      responses: {
        200: {
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          description: "The file; content type from its extension",
        },
        404: json(ErrorBody, "not_found"),
      },
    });
    app.get("/outputs/:id/*", async (c) => {
      const id = c.req.param("id");
      const prefix = `${basePath}/outputs/${id}/`;
      const pathname = new URL(c.req.url).pathname;
      let path: string;
      try {
        path = decodeURIComponent(pathname.slice(prefix.length));
      } catch {
        return c.json(errorBody("not_found", "No such file"), 404);
      }
      const file = pathname.startsWith(prefix) ? await outputs.read(id, path) : undefined;
      if (!file) return c.json(errorBody("not_found", "No such file"), 404);
      return new Response(file.body, {
        headers: { "content-type": file.type, "content-length": String(file.size) },
      });
    });
    app.all("/outputs/:id/*", notAllowed);
  }

  if (options.mcp ?? true) {
    app.openAPIRegistry.registerPath({
      method: "post",
      path: "/mcp",
      summary: "MCP (Streamable HTTP, JSON-RPC)",
      description:
        "The same operations as MCP tools: list_tasks, start_job, get_job, job_logs, follow_job, list_jobs, interrupt_job, cleanup_jobs (+ add_task, remove_task with task upload). Use an MCP client.",
      responses: { 200: { description: "JSON-RPC response, or an SSE stream of them" } },
    });
    const mcp = createJobsMcpHandler(manager, { registry });
    app.all("/mcp", (c) => mcp.fetch(c.req.raw));
  }

  app.notFound((c) => c.json(errorBody("not_found", "No such route"), 404));
  app.onError((e, c) => {
    if (e instanceof JobsError) return c.json(errorBody(e.code, e.message, e.issues), statusOf(e));
    // the validators' own refusals: a body that is not JSON, an unsupported content type
    if (e instanceof HTTPException && e.status < 500)
      return c.json(errorBody("invalid_params", e.message), 400);
    return c.json(errorBody("internal", e instanceof Error ? e.message : String(e)), 500);
  });
  return app; // the base-path clone: its error and not-found handlers are the ones that apply
}

/** The app as a plain fetch handler (`Request -> Response`). */
export function createJobsHandler(manager: JobManager, options: JobsAppOptions = {}): JobsHandler {
  const app = createJobsApp(manager, options);
  return async (request) => app.fetch(request);
}

function invalidParams(what: string, zodIssues: z.core.$ZodIssue[]): JobsError {
  const issues = zodIssues.map((i) => ({
    path: `/${i.path.map(String).join("/")}`,
    message: i.message,
  }));
  return new JobsError("invalid_params", describeIssues(what, issues), issues);
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
  open: (signal: AbortSignal) => AsyncGenerator<Message>,
  format: (m: Message) => string,
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

function errorBody(code: string, message: string, issues?: Issue[]) {
  return { error: issues ? { code, message, issues } : { code, message } };
}

function notAllowed(c: Context): Response {
  return c.json(errorBody("method_not_allowed", "Method not allowed"), 405);
}
