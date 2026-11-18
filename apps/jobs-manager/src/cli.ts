#!/usr/bin/env node
// `jobs`: run the jobs server, or drive one over REST. Built on citty; `jobs <command> --help`
// shows each command's options.
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ArgsDef, type CommandDef, defineCommand, runCommand, runMain } from "citty";
import { JobsClient, JobsClientError } from "./client.ts";
import { createJobManager } from "./job-manager.ts";
import { discoverTasks } from "./launchers.ts";
import { serve as serveHttp } from "./node-server.ts";
import { folderOutputs } from "./outputs.ts";
import { createJobsApp } from "./rest.ts";
import { addTask, folderRegistry, removeTask } from "./tasks-dir.ts";
import { isTerminal, type JobMessage, type JobStatus, JobsError, type Json } from "./types.ts";
import { results, verifyJob } from "./verify.ts";

const DEFAULT_URL = "http://127.0.0.1:8080";

/** Exit codes: the job's outcome for start --wait / wait / logs --follow, else 0 or 3. */
export const EXIT = { done: 0, error: 1, interrupted: 2, usage: 3, timeout: 124 } as const;

const OVERVIEW = `jobs: run named tasks as shell commands and track them

Server
  jobs serve [--tasks ./tasks] [--data ./.jobs] [--port 8080] [--host 127.0.0.1]
             [--max-concurrent 4] [--retention-hours N] [--base-path /api]
             [--allow-task-upload] [--no-mcp] [--cors origin,origin|*] [--outputs ./outputs]
             REST at <base-path>/, OpenAPI at <base-path>/openapi.json,
             MCP (Streamable HTTP) at <base-path>/mcp, results at <base-path>/outputs/<id>/

Tasks (the server re-scans its tasks directory on every request)
  jobs tasks [--json]                         list the server's tasks
  jobs tasks add <script> [--name n] [--cleanup script] [--tasks ./tasks]
  jobs tasks remove <name> [--tasks ./tasks]

Jobs
  jobs start <task> [-p key=value]... [--params json] [--input file|-] [--wait | --follow] [--json]
  jobs status <id>                            pending | running | done | error | interrupted
  jobs info <id>                              the job's record as JSON
  jobs list [--status s1,s2] [--task name] [--json]
  jobs logs <id> [--since stamp] [--follow] [--until-message] [--json]
  jobs wait <id> [--timeout 30s]              exit 0 done, 1 error, 2 interrupted, 124 timeout
  jobs result <id> [--last]                   the job's result messages (stdout lines) as JSONL
  jobs verify <id> [--status s] [--count n] [--contains json]... [--last json] [--expect file.jsonl]
  jobs interrupt <id>
  jobs cleanup [--older-than 24h | --before stamp] [--json]

Options for every client command: --url <server> (default: $JOBS_URL or ${DEFAULT_URL}).
Run "jobs <command> --help" for details.`;

// ---------- shared options and helpers ----------

const urlArg = {
  url: { type: "string", description: `Server URL (default: $JOBS_URL or ${DEFAULT_URL})` },
} as const satisfies ArgsDef;
const jsonArg = {
  json: { type: "boolean", description: "Machine-readable output" },
} as const satisfies ArgsDef;
const idArg = {
  id: { type: "positional", required: true, description: "Job id" },
} as const satisfies ArgsDef;

function client(args: { url?: string }): JobsClient {
  return new JobsClient(args.url ?? process.env.JOBS_URL ?? DEFAULT_URL);
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Thrown for bad command lines; reported without a stack, exit 3. */
class UsageError extends Error {}

/** Every value given for a repeatable option (citty keeps only the last one). */
function repeated(rawArgs: string[], names: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i] as string;
    if (names.includes(arg) && i + 1 < rawArgs.length) {
      values.push(rawArgs[i + 1] as string);
      i++;
      continue;
    }
    const name = names.find((n) => n.startsWith("--") && arg.startsWith(`${n}=`));
    if (name) values.push(arg.slice(name.length + 1));
  }
  return values;
}

function parseJson(text: string, what: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new UsageError(`${what} must be valid JSON: ${text}`);
  }
}

/** `--params <json>` merged with every `-p key=value` (the value as JSON when it parses, else a string). */
export function parseParams(rawArgs: string[], paramsJson?: string): Json {
  const pairs = repeated(rawArgs, ["-p", "--param"]);
  const base = paramsJson === undefined ? null : parseJson(paramsJson, "--params");
  if (pairs.length === 0) return base;
  if (base !== null && (typeof base !== "object" || Array.isArray(base))) {
    throw new UsageError("-p key=value needs --params to be a JSON object");
  }
  const params: Record<string, Json> = { ...(base ?? {}) };
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`-p expects key=value, got "${pair}"`);
    const raw = pair.slice(eq + 1);
    let value: Json;
    try {
      value = JSON.parse(raw) as Json;
    } catch {
      value = raw;
    }
    params[pair.slice(0, eq)] = value;
  }
  return params;
}

/** "250ms", "30s", "5m", "2h", "1d" or a plain number of milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(text.trim());
  if (!match) throw new UsageError(`not a duration: "${text}" (use e.g. 30s, 5m, 2h, 1d)`);
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * (units[match[2] ?? "ms"] as number);
}

function exitFor(status: JobStatus | undefined): number {
  if (status === "done") return EXIT.done;
  return status === "interrupted" ? EXIT.interrupted : EXIT.error;
}

const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** One message as a readable line: time, status, then where it came from and its payload. */
export function formatMessage(m: JobMessage): string {
  const head = `${new Date(m.stamp).toISOString().slice(11, 23)}  ${m.status}`;
  if ("message" in m && m.message !== undefined) {
    return `${head.padEnd(26)} stdout  ${show(m.message)}`;
  }
  if ("error" in m && m.error !== undefined) {
    return m.status === "running"
      ? `${head.padEnd(26)} stderr  ${show(m.error)}`
      : `${head.padEnd(26)} ${show(m.error)}`;
  }
  return head;
}

/** Follows a job to its end, optionally printing each message; resolves with the last message. */
async function follow(
  api: JobsClient,
  id: string,
  options: {
    print?: "text" | "json";
    since?: number;
    signal?: AbortSignal;
    untilMessage?: boolean;
  } = {},
): Promise<JobMessage | undefined> {
  let last: JobMessage | undefined;
  for await (const m of api.logs(id, options.since ?? 0, {
    follow: true,
    signal: options.signal,
  })) {
    last = m;
    if (options.print === "json") out(JSON.stringify(m));
    else if (options.print === "text") out(formatMessage(m));
    if (options.untilMessage && "message" in m) break;
  }
  return last;
}

function readInput(spec: string | undefined) {
  if (spec === undefined) return undefined;
  return spec === "-" ? process.stdin : createReadStream(spec);
}

// ---------- commands ----------

const serve = defineCommand({
  meta: { name: "serve", description: "Run the jobs server over a tasks directory" },
  args: {
    tasks: {
      type: "string",
      default: "./tasks",
      description: "Tasks directory, re-scanned on every request; created when missing",
    },
    data: {
      type: "string",
      default: "./.jobs",
      description: "Directory holding one folder per job",
    },
    port: { type: "string", default: "8080", description: "Port (0 picks a free one)" },
    host: { type: "string", default: "127.0.0.1", description: "Interface to listen on" },
    "max-concurrent": { type: "string", default: "4", description: "Jobs running at once" },
    "retention-hours": {
      type: "string",
      description: "Clean up finished jobs older than this many hours",
    },
    "base-path": { type: "string", default: "", description: "Path prefix of the API, e.g. /api" },
    "allow-task-upload": {
      type: "boolean",
      default: false,
      description:
        "Accept PUT/DELETE /tasks/:name and the MCP add_task/remove_task tools: anyone who can reach the server can then run code on it",
    },
    mcp: {
      type: "boolean",
      default: true,
      description: "Serve MCP at <base-path>/mcp (--no-mcp to turn off)",
    },
    cors: {
      type: "string",
      description: "Send CORS headers for these origins: comma-separated, or * for any",
    },
    outputs: {
      type: "string",
      description:
        "Results folder: each job gets <dir>/<id>/ as JOB_OUTPUT_DIR, served at <base-path>/outputs/<id>/ (JOB_OUTPUT_URL)",
    },
  },
  async run({ args }) {
    const basePath = args["base-path"].replace(/\/+$/, ""); // "/api/" and "/api" are the same API
    await mkdir(args.tasks, { recursive: true }); // `tasks add` fills it while the server runs
    const skipped: string[] = [];
    const initial = await discoverTasks(args.tasks, undefined, (task, reason) =>
      skipped.push(`skipped task ${task}: ${reason}`),
    );
    const outputs = args.outputs ? resolve(args.outputs) : undefined;
    const retentionHours = args["retention-hours"] ? Number(args["retention-hours"]) : undefined;
    const manager = await createJobManager({
      root: args.data,
      tasks: initial,
      maxConcurrent: Number(args["max-concurrent"]),
      retention: retentionHours ? { maxAgeMs: retentionHours * 3_600_000 } : undefined,
      outputs: outputs ? { dir: outputs, url: `${basePath}/outputs` } : undefined,
    });
    const rescan = async () => manager.setTasks(await discoverTasks(args.tasks));
    const origins = args.cors
      ?.split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const app = createJobsApp(manager, {
      basePath,
      mcp: args.mcp,
      registry: args["allow-task-upload"] ? folderRegistry(args.tasks, rescan) : undefined,
      cors: origins?.length ? { origin: origins.includes("*") ? "*" : origins } : undefined,
      outputs: outputs ? folderOutputs(outputs) : undefined,
    });
    const server = await serveHttp(
      async (request) => {
        await rescan(); // tasks added or removed in the folder apply at once
        return app.fetch(request);
      },
      { port: Number(args.port), host: args.host },
    );
    out(`jobs listening on http://${args.host}:${server.port}${basePath}`);
    const names = initial.map((t) => (t.cleanup ? `${t.name} (+cleanup)` : t.name));
    note(`tasks in ${resolve(args.tasks)}: ${names.join(", ") || "(none)"}`);
    for (const line of skipped) note(line);
    if (outputs) note(`outputs in ${outputs}`);
    if (args.mcp) note(`mcp at http://${args.host}:${server.port}${basePath}/mcp`);
    if (args["allow-task-upload"])
      note("task upload is on: anyone who can reach this server can run code on it");
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await server.close();
      await manager.close(); // running jobs are recorded as interrupted
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {}); // until a signal
  },
});

const tasksAdd = defineCommand({
  meta: { name: "add", description: "Copy a script into the tasks directory as a new task" },
  args: {
    script: { type: "positional", required: true, description: "Job script (.js .ts .py .sh …)" },
    name: { type: "string", description: "Task name (default: the script's file name)" },
    cleanup: { type: "string", description: "Cleanup script for the task" },
    tasks: {
      type: "string",
      default: "./tasks",
      description: "The server's tasks directory",
    },
  },
  async run({ args }) {
    try {
      const { name, files } = await addTask(args.tasks, args.script, {
        name: args.name,
        cleanup: args.cleanup,
      });
      out(`added ${name}: ${files.join(", ")}`);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  },
});

const tasksRemove = defineCommand({
  meta: { name: "remove", description: "Delete a task's scripts from the tasks directory" },
  args: {
    name: { type: "positional", required: true, description: "Task name" },
    tasks: {
      type: "string",
      default: "./tasks",
      description: "The server's tasks directory",
    },
  },
  async run({ args }) {
    try {
      out(`removed ${(await removeTask(args.tasks, args.name)).join(", ")}`);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  },
});

const tasks = defineCommand({
  meta: { name: "tasks", description: "List, add or remove tasks" },
  args: { ...urlArg, ...jsonArg },
  subCommands: { add: tasksAdd, remove: tasksRemove },
  async run({ args, rawArgs }) {
    if (["add", "remove"].includes(rawArgs[0] ?? "")) return; // handled by the sub-command
    const list = await client(args).tasks();
    if (args.json) return out(JSON.stringify(list));
    for (const t of list) out(t.hasCleanup ? `${t.name}  (+cleanup)` : t.name);
  },
});

const start = defineCommand({
  meta: { name: "start", description: "Start a job; prints its id" },
  args: {
    task: { type: "positional", required: true, description: "Task name" },
    param: {
      type: "string",
      alias: "p",
      description:
        "A parameter as key=value (repeatable; the value is parsed as JSON if it can be)",
    },
    params: { type: "string", description: "All parameters as JSON" },
    input: { type: "string", description: "File to send as the job's input, or - for stdin" },
    wait: { type: "boolean", description: "Wait for the job to finish; exit code from its status" },
    follow: { type: "boolean", description: "Print the job's messages until it finishes" },
    ...jsonArg,
    ...urlArg,
  },
  async run({ args, rawArgs }) {
    const api = client(args);
    const params = parseParams(rawArgs, args.params);
    const id = await api.start(args.task, params, readInput(args.input));
    out(id);
    if (!args.wait && !args.follow) return;
    const print = args.follow ? (args.json ? "json" : "text") : undefined;
    const last = await follow(api, id, { print });
    if (!args.follow) {
      const error = last && "error" in last && last.error !== undefined ? last.error : undefined;
      note(error === undefined ? `${last?.status}` : `${last?.status}: ${show(error)}`);
    }
    process.exitCode = exitFor(last?.status);
  },
});

const status = defineCommand({
  meta: { name: "status", description: "Print a job's status" },
  args: { ...idArg, ...urlArg },
  async run({ args }) {
    out(await client(args).status(args.id));
  },
});

const info = defineCommand({
  meta: { name: "info", description: "Print a job's record as JSON" },
  args: { ...idArg, ...urlArg },
  async run({ args }) {
    out(JSON.stringify(await client(args).info(args.id), null, 2));
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List jobs, oldest first" },
  args: {
    status: { type: "string", description: "Only these statuses, comma-separated" },
    task: { type: "string", description: "Only jobs of this task" },
    ...jsonArg,
    ...urlArg,
  },
  async run({ args }) {
    const statuses = args.status?.split(",").filter(Boolean) as JobStatus[] | undefined;
    const jobs = [];
    for await (const job of client(args).list({ status: statuses, task: args.task }))
      jobs.push(job);
    if (args.json) return out(JSON.stringify(jobs));
    const width = Math.max(4, ...jobs.map((j) => j.task.length));
    for (const j of jobs) {
      const created = new Date(j.created).toISOString();
      out(`${j.id}  ${j.task.padEnd(width)}  ${j.status.padEnd(11)}  ${created}`);
    }
  },
});

const logs = defineCommand({
  meta: { name: "logs", description: "Print a job's messages" },
  args: {
    ...idArg,
    since: { type: "string", description: "Only messages after this stamp" },
    follow: { type: "boolean", description: "Keep printing until the job finishes" },
    "until-message": {
      type: "boolean",
      description: "With --follow: stop after the first result message",
    },
    ...jsonArg,
    ...urlArg,
  },
  async run({ args }) {
    const api = client(args);
    const since = args.since === undefined ? 0 : Number(args.since);
    if (!Number.isFinite(since))
      throw new UsageError(`--since must be a stamp, got "${args.since}"`);
    const print = args.json ? "json" : "text";
    if (args.follow) {
      const last = await follow(api, args.id, {
        print,
        since,
        untilMessage: args["until-message"],
      });
      if (!args["until-message"]) process.exitCode = exitFor(last?.status);
      return;
    }
    for await (const m of api.logs(args.id, since, { follow: false })) {
      out(print === "json" ? JSON.stringify(m) : formatMessage(m));
    }
  },
});

const wait = defineCommand({
  meta: { name: "wait", description: "Wait for a job to finish; exit code from its status" },
  args: {
    ...idArg,
    timeout: { type: "string", description: "Give up after this long (exit 124), e.g. 30s" },
    ...urlArg,
  },
  async run({ args }) {
    const controller = new AbortController();
    const timer = args.timeout
      ? setTimeout(() => controller.abort(), parseDuration(args.timeout))
      : undefined;
    const last = await follow(client(args), args.id, { signal: controller.signal });
    clearTimeout(timer);
    if (!last || !isTerminal(last.status)) {
      note(`still ${last?.status ?? "unknown"} after ${args.timeout}`);
      process.exitCode = EXIT.timeout;
      return;
    }
    out(last.status);
    process.exitCode = exitFor(last.status);
  },
});

const result = defineCommand({
  meta: { name: "result", description: "Print a job's result messages (stdout lines) as JSONL" },
  args: {
    ...idArg,
    last: { type: "boolean", description: "Only the last result message" },
    ...urlArg,
  },
  async run({ args }) {
    const messages = [];
    for await (const m of client(args).logs(args.id, 0, { follow: false })) messages.push(m);
    const values = results(messages);
    for (const value of args.last ? values.slice(-1) : values) out(JSON.stringify(value));
  },
});

const verify = defineCommand({
  meta: {
    name: "verify",
    description: "Wait for a job, then check its status and results (exit 0 ok, 1 failed)",
  },
  args: {
    ...idArg,
    status: { type: "string", description: "Expected final status" },
    count: { type: "string", description: "Expected number of result messages" },
    contains: {
      type: "string",
      description: "JSON pattern some result must match (repeatable; subset match)",
    },
    last: { type: "string", description: "JSON pattern the last result must match" },
    expect: { type: "string", description: "JSONL file: the results, in order, one per line" },
    ...urlArg,
  },
  async run({ args, rawArgs }) {
    const api = client(args);
    await follow(api, args.id);
    const messages = [];
    for await (const m of api.logs(args.id, 0, { follow: false })) messages.push(m);
    const expected = args.expect
      ? (await readFile(args.expect, "utf8"))
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => parseJson(l, `a line of ${args.expect}`))
      : undefined;
    const outcome = verifyJob(messages, {
      status: args.status as JobStatus | undefined,
      count: args.count === undefined ? undefined : Number(args.count),
      contains: repeated(rawArgs, ["--contains"]).map((c) => parseJson(c, "--contains")),
      last: args.last === undefined ? undefined : parseJson(args.last, "--last"),
      expect: expected,
    });
    if (outcome.ok) out("ok");
    for (const failure of outcome.failures) out(failure);
    process.exitCode = outcome.ok ? 0 : 1;
  },
});

const interrupt = defineCommand({
  meta: { name: "interrupt", description: "Stop a job; prints its final status" },
  args: { ...idArg, ...urlArg },
  async run({ args }) {
    out(await client(args).interrupt(args.id));
  },
});

const cleanup = defineCommand({
  meta: { name: "cleanup", description: "Remove finished jobs, running their cleanup scripts" },
  args: {
    "older-than": {
      type: "string",
      description: "Only jobs that finished longer ago than this, e.g. 24h",
    },
    before: { type: "string", description: "Only jobs that finished before this stamp" },
    ...jsonArg,
    ...urlArg,
  },
  async run({ args }) {
    let before: number | undefined;
    if (args["older-than"]) before = Date.now() - parseDuration(args["older-than"]);
    else if (args.before !== undefined) before = Number(args.before);
    const outcome = await client(args).cleanup(before);
    if (args.json) return out(JSON.stringify(outcome));
    out(`removed ${outcome.removed.length}, failed ${outcome.failed.length}`);
    for (const f of outcome.failed) out(`  ${f.id}: ${f.error}`);
  },
});

const commands = {
  serve,
  tasks,
  start,
  status,
  info,
  list,
  logs,
  wait,
  result,
  verify,
  interrupt,
  cleanup,
};

export const main = defineCommand({
  meta: { name: "jobs", description: "Run named tasks as shell commands and track them" },
  subCommands: commands as unknown as Record<string, CommandDef<ArgsDef>>,
});

export async function cli(argv: string[]): Promise<void> {
  const [command] = argv;
  if (command === undefined || command === "help") return out(OVERVIEW);
  if (argv.includes("--help") || argv.includes("-h")) return runMain(main, { rawArgs: argv });
  if (!(command in commands)) {
    note(`jobs: unknown command: ${command}\n\n${OVERVIEW}`);
    process.exitCode = EXIT.usage;
    return;
  }
  try {
    await runCommand(main, { rawArgs: argv });
  } catch (e) {
    if (e instanceof JobsError) note(`jobs: ${e.code}: ${e.message}`);
    else if (e instanceof JobsClientError || e instanceof UsageError) note(`jobs: ${e.message}`);
    else if ((e as { name?: string }).name === "CLIError") note(`jobs: ${(e as Error).message}`);
    else throw e;
    process.exitCode = EXIT.usage;
  }
}

if (import.meta.main) {
  // `jobs logs … | head -1`: the reader left, so stop quietly like other Unix filters.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e;
    process.exit(0);
  });
  await cli(process.argv.slice(2));
}
