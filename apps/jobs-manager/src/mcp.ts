import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isSafeId } from "./ids.ts";
import {
  type ByteInput,
  isTerminal,
  type JobManager,
  type JobMessage,
  type JobStatus,
  JobsError,
  type Json,
  type TaskRegistry,
} from "./types.ts";

/**
 * MCP over any JobManager: tools to list tasks, start, follow, inspect, interrupt and clean up
 * jobs, plus `add_task` / `remove_task` when a registry is given. Streamable HTTP, stateless (a
 * fresh server per request), Web-standard only: the returned `fetch` runs wherever the REST app
 * does. `createJobsApp` mounts it at `<basePath>/mcp`.
 *
 * Logs are followed with a cursor: `job_logs` returns the messages after `since`, waiting up to
 * `waitMs` for the first new one, and the `next` cursor to pass back. Every MCP client can do
 * that, unlike progress-notification streams.
 */
export type JobsMcpOptions = { registry?: TaskRegistry };

export type JobsMcpHandler = { fetch: (request: Request) => Promise<Response> };

/** Longest a `job_logs` call waits for a new message. */
export const MAX_WAIT_MS = 60_000;
/** Most messages one `job_logs` call returns; `finished` stays false while more are pending. */
export const MAX_PAGE = 1_000;

const STATUS = z.enum(["pending", "running", "done", "error", "interrupted"]);
const JOB_ID = z.string().describe("Job id, as returned by start_job");

export function createJobsMcpHandler(
  manager: JobManager,
  options: JobsMcpOptions = {},
): JobsMcpHandler {
  const handler = createMcpHandler(() => createJobsMcpServer(manager, options));
  return { fetch: (request) => handler.fetch(request) };
}

export function createJobsMcpServer(manager: JobManager, options: JobsMcpOptions = {}): McpServer {
  const server = new McpServer({ name: "jobs-manager", version: "0.0.0" });

  server.registerTool(
    "list_tasks",
    { description: "List the tasks a job can be started from." },
    async () => ok({ tasks: await manager.tasks() }),
  );

  server.registerTool(
    "start_job",
    {
      description:
        "Start a job of a task. Returns its id at once; follow it with job_logs. `params` reaches the script as JOB_PARAMS (JSON); the input, if any, as its stdin.",
      inputSchema: z.object({
        task: z.string(),
        params: z.json().optional().describe("Any JSON value"),
        input: z.string().optional().describe("Text sent to the script's stdin"),
        inputBase64: z.string().optional().describe("Binary stdin, base64-encoded"),
      }),
    },
    ({ task, params, input, inputBase64 }) =>
      run(async () => {
        if (input !== undefined && inputBase64 !== undefined)
          throw new JobsError("invalid_params", "give input or inputBase64, not both");
        const bytes =
          input !== undefined
            ? new TextEncoder().encode(input)
            : inputBase64 !== undefined
              ? fromBase64(inputBase64)
              : undefined;
        const stdin: ByteInput | undefined = bytes ? [bytes] : undefined;
        return { jobId: await manager.start(task, (params ?? null) as Json, stdin) };
      }),
  );

  server.registerTool(
    "get_job",
    {
      description: "A job's record: task, params, status, created and updated stamps.",
      inputSchema: z.object({ id: JOB_ID }),
    },
    ({ id }) => run(async () => manager.info(checkId(id))),
  );

  server.registerTool(
    "job_logs",
    {
      description: `A job's messages after the cursor \`since\` (omit it for all). With waitMs, waits up to that long (max ${MAX_WAIT_MS} ms) for a new message. Returns { messages, next, status, finished }: pass \`next\` back as \`since\` and repeat until finished is true.`,
      inputSchema: z.object({
        id: JOB_ID,
        since: z.number().optional().describe("Cursor: the `next` of the previous call"),
        waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
      }),
    },
    ({ id, since, waitMs }) => run(async () => logsPage(manager, checkId(id), since, waitMs ?? 0)),
  );

  server.registerTool(
    "list_jobs",
    {
      description: "List jobs, oldest first, optionally filtered by status and task.",
      inputSchema: z.object({ status: z.array(STATUS).optional(), task: z.string().optional() }),
    },
    ({ status, task }) =>
      run(async () => {
        const jobs = [];
        for await (const info of manager.list({ status: status as JobStatus[] | undefined, task }))
          jobs.push(info);
        return { jobs: jobs.sort((a, b) => a.created - b.created) };
      }),
  );

  server.registerTool(
    "interrupt_job",
    {
      description: "Stop a pending or running job. Returns its final status.",
      inputSchema: z.object({ id: JOB_ID }),
      annotations: { destructiveHint: true },
    },
    ({ id }) => run(async () => ({ id, status: await manager.interrupt(checkId(id)) })),
  );

  server.registerTool(
    "cleanup_jobs",
    {
      description:
        "Remove finished jobs (and run their tasks' cleanup scripts) that finished at or before `before` (epoch ms; default now).",
      inputSchema: z.object({ before: z.number().optional() }),
      annotations: { destructiveHint: true },
    },
    ({ before }) => run(async () => manager.cleanup(before)),
  );

  const { registry } = options;
  if (registry) {
    server.registerTool(
      "add_task",
      {
        description:
          "Add a task from script source. `ext` picks the launcher (sh, py, js, ts, …); `cleanup` is an optional cleanup script with the same extension. The server runs this code.",
        inputSchema: z.object({
          name: z.string(),
          ext: z.string(),
          script: z.string(),
          cleanup: z.string().optional(),
        }),
      },
      (task) => run(async () => registry.add(task)),
    );
    server.registerTool(
      "remove_task",
      {
        description: "Remove a task.",
        inputSchema: z.object({ name: z.string() }),
        annotations: { destructiveHint: true },
      },
      ({ name }) =>
        run(async () => {
          await registry.remove(name);
          return { removed: name };
        }),
    );
  }
  return server;
}

/** Messages after `since`; when there are none yet and the job is live, waits up to `waitMs` for one. */
async function logsPage(
  manager: JobManager,
  id: string,
  since: number | undefined,
  waitMs: number,
) {
  const messages = await read(manager.logs(id, since, { follow: false }));
  if (messages.length === 0 && waitMs > 0) {
    const signal = AbortSignal.timeout(waitMs);
    for await (const message of manager.logs(id, since, { follow: true, signal })) {
      messages.push(message);
      break; // something arrived: return it with whatever else is already recorded
    }
    const last = messages.at(-1)?.stamp;
    if (last !== undefined)
      messages.push(...(await read(manager.logs(id, last, { follow: false }))));
  }
  const page = messages.slice(0, MAX_PAGE);
  const status = (await manager.info(id)).status;
  const ended =
    page.some((m) => isTerminal(m.status)) || (isTerminal(status) && messages.length <= MAX_PAGE);
  return { messages: page, next: page.at(-1)?.stamp ?? since ?? 0, status, finished: ended };
}

async function read(messages: AsyncGenerator<JobMessage>): Promise<JobMessage[]> {
  const out: JobMessage[] = [];
  for await (const m of messages) out.push(m);
  return out;
}

function checkId(id: string): string {
  if (!isSafeId(id)) throw new JobsError("unknown_job", `Unknown job: ${id}`);
  return id;
}

function fromBase64(text: string): Uint8Array {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    throw new JobsError("invalid_params", "inputBase64 is not valid base64");
  }
}

function ok(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** Runs a tool body; a JobsError becomes a tool error naming its code, so the model can react. */
async function run(body: () => Promise<object>) {
  try {
    return ok((await body()) as Record<string, unknown>);
  } catch (e) {
    const text = e instanceof JobsError ? `${e.code}: ${e.message}` : `internal: ${String(e)}`;
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}
