import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  createJobsApp,
  discoverTasks,
  folderRegistry,
  type JobMessage,
  type JobsAppOptions,
  type ProcessJobManager,
} from "../src/index.ts";
import { task, tempDir } from "./helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let manager: ProcessJobManager;
let client: Client;

const TASKS = [
  task("quick", "quick.mjs"),
  task("count", "count.py"),
  task("stream", "stream.ts"),
  task("sleepy", "sleepy.sh"),
  task("fail", "fail.sh"),
  task("burst", "burst.mjs"),
];

/** An MCP client talking to the app in process: no server, the app's fetch is the transport. */
async function connect(options: JobsAppOptions = {}) {
  const app = createJobsApp(manager, options);
  client = new Client({ name: "jobs-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://jobs.test/mcp"), {
      fetch: async (url, init) => app.fetch(new Request(url, init)),
    }),
  );
}

type Logs = { messages: JobMessage[]; next: number; status: string; finished: boolean };

async function tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as T;
}

/** Follows a job with the cursor until `finished`, counting the calls it took. */
async function follow(id: string, waitMs = 5_000) {
  const messages: JobMessage[] = [];
  let since: number | undefined;
  let calls = 0;
  for (;;) {
    calls++;
    const page = await tool<Logs>("job_logs", { id, since, waitMs });
    messages.push(...page.messages);
    since = page.next;
    if (page.finished) return { messages, calls, status: page.status };
  }
}

beforeEach(async () => {
  dir = await tempDir();
  manager = await createJobManager({ root: join(dir.path, "jobs"), tasks: TASKS });
});

afterEach(async () => {
  await client?.close();
  await manager.close();
  await dir.remove();
});

describe("MCP tools", () => {
  it("lists the job tools, and the task tools only with a registry", async () => {
    await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cleanup_jobs",
      "get_job",
      "interrupt_job",
      "job_logs",
      "list_jobs",
      "list_tasks",
      "start_job",
    ]);
    await client.close();

    const tasksDir = join(dir.path, "tasks");
    await connect({ registry: folderRegistry(tasksDir) });
    const withRegistry = (await client.listTools()).tools.map((t) => t.name);
    expect(withRegistry).toEqual(expect.arrayContaining(["add_task", "remove_task"]));
  });

  it("lists tasks and starts a job with params and a text or base64 input", async () => {
    await connect();
    expect(await tool("list_tasks")).toEqual({
      tasks: TASKS.map((t) => ({ name: t.name, hasCleanup: false })),
    });

    const { jobId } = await tool<{ jobId: string }>("start_job", {
      task: "count",
      params: { n: 2 },
      input: "a\nb\n",
    });
    const run = await follow(jobId);
    expect(run.status).toBe("done");
    expect(run.messages).toContainEqual(
      expect.objectContaining({ message: { bytes: 4, lines: 2, params: { n: 2 } } }),
    );

    const b64 = await tool<{ jobId: string }>("start_job", {
      task: "count",
      inputBase64: btoa("xyz"),
    });
    expect((await follow(b64.jobId)).messages).toContainEqual(
      expect.objectContaining({ message: { bytes: 3, lines: 0, params: null } }),
    );
    expect(await tool("get_job", { id: jobId })).toMatchObject({
      id: jobId,
      task: "count",
      status: "done",
    });
  });

  it("follows a running job with the cursor: every message once, over several long-polls", async () => {
    await connect();
    const { jobId } = await tool<{ jobId: string }>("start_job", {
      task: "stream",
      params: { seconds: 1.5, intervalMs: 300 },
    });
    const run = await follow(jobId);
    const ticks = run.messages.flatMap((m) =>
      "message" in m && m.message && typeof m.message === "object"
        ? [(m.message as { tick: number }).tick]
        : [],
    );
    expect(ticks).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(run.messages.map((m) => m.stamp)).size).toBe(run.messages.length);
    expect(run.calls).toBeGreaterThan(2); // it waited for new lines, not for the end
    expect(run.status).toBe("done");
  });

  it("does not report finished before the last lines and the final message are returned", async () => {
    await connect();
    for (const waitMs of [0, 5_000]) {
      for (let run = 0; run < 5; run++) {
        const { jobId } = await tool<{ jobId: string }>("start_job", { task: "burst" });
        const followed = await follow(jobId, waitMs);
        const all = [];
        for await (const m of manager.logs(jobId, 0, { follow: false })) all.push(m);
        expect(followed.messages).toEqual(all);
        expect(followed.messages.at(-1)?.status).toBe("done");
      }
    }
  });

  it("returns at once with no messages when nothing new arrives within waitMs", async () => {
    await connect();
    const { jobId } = await tool<{ jobId: string }>("start_job", { task: "sleepy" });
    let page = await tool<Logs>("job_logs", { id: jobId, waitMs: 2_000 });
    while (!page.messages.some((m) => "message" in m))
      page = await tool<Logs>("job_logs", { id: jobId, since: page.next, waitMs: 2_000 });
    const started = Date.now();
    const quiet = await tool<Logs>("job_logs", { id: jobId, since: page.next, waitMs: 300 });
    expect(quiet).toMatchObject({
      messages: [],
      next: page.next,
      status: "running",
      finished: false,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    await tool("interrupt_job", { id: jobId });
  });

  it("interrupts a running job, lists and cleans up jobs", async () => {
    await connect();
    const sleepy = await tool<{ jobId: string }>("start_job", { task: "sleepy" });
    expect(await tool("interrupt_job", { id: sleepy.jobId })).toEqual({
      id: sleepy.jobId,
      status: "interrupted",
    });
    const quick = await tool<{ jobId: string }>("start_job", { task: "quick" });
    await follow(quick.jobId);

    const { jobs } = await tool<{ jobs: { id: string }[] }>("list_jobs", {
      status: ["interrupted"],
    });
    expect(jobs.map((j) => j.id)).toEqual([sleepy.jobId]);

    const cleaned = await tool<{ removed: string[] }>("cleanup_jobs");
    expect(cleaned.removed.sort()).toEqual([sleepy.jobId, quick.jobId].sort());
  });

  it("reports errors as tool errors naming the code", async () => {
    await connect();
    const unknownJob = await client.callTool({ name: "get_job", arguments: { id: "nope" } });
    expect(unknownJob.isError).toBe(true);
    expect(JSON.stringify(unknownJob.content)).toMatch(/unknown_job/);
    const unknownTask = await client.callTool({ name: "start_job", arguments: { task: "nope" } });
    expect(JSON.stringify(unknownTask.content)).toMatch(/unknown_task/);
  });

  it("adds and removes a task when a registry is given", async () => {
    const tasksDir = join(dir.path, "tasks");
    await connect({
      registry: folderRegistry(tasksDir, async () =>
        manager.setTasks(await discoverTasks(tasksDir)),
      ),
    });
    expect(
      await tool("add_task", { name: "hi", ext: "py", script: "print('{\"hi\": 1}')" }),
    ).toEqual({
      name: "hi",
      hasCleanup: false,
    });
    expect(await tool("list_tasks")).toEqual({ tasks: [{ name: "hi", hasCleanup: false }] });
    const { jobId } = await tool<{ jobId: string }>("start_job", { task: "hi" });
    expect((await follow(jobId)).messages).toContainEqual(
      expect.objectContaining({ message: { hi: 1 } }),
    );
    expect(await tool("remove_task", { name: "hi" })).toEqual({ removed: "hi" });
    expect(await tool("list_tasks")).toEqual({ tasks: [] });
  });
});
