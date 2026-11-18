import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  createJobsApp,
  discoverTasks,
  folderOutputs,
  type JobMessage,
  type ProcessJobManager,
  type TaskDefinition,
} from "../src/index.ts";
import { encodePpm, makePpm, parsePpm, resizeNearest, SCHEMAS_DIR, tempDir } from "./helpers.ts";
import { ndjson } from "./rest-helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let outputs: string;
let tasks: TaskDefinition[];
let manager: ProcessJobManager;
let app: ReturnType<typeof createJobsApp>;

const IMAGE = makePpm(40, 30);
const SIZES = [16, 8];

/** What the resizer must return for `size`, byte for byte. */
const expected = (size: number) => encodePpm(resizeNearest(parsePpm(IMAGE), size));

beforeEach(async () => {
  dir = await tempDir();
  outputs = join(dir.path, "outputs");
  tasks = await discoverTasks(SCHEMAS_DIR);
  manager = await createJobManager({
    root: join(dir.path, "jobs"),
    tasks,
    outputs: { dir: outputs, url: "/outputs" },
  });
  app = createJobsApp(manager, { outputs: folderOutputs(outputs) });
});

afterEach(async () => {
  await manager.close();
  await dir.remove();
});

const call = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://jobs.test${path}`, init));

async function startRaw(task: string, params: unknown, body: Uint8Array): Promise<string> {
  const response = await call(
    `/tasks/${task}/jobs?params=${encodeURIComponent(JSON.stringify(params))}`,
    {
      method: "POST",
      headers: { "content-type": "image/x-portable-pixmap" },
      body: body as BodyInit,
    },
  );
  expect(response.status).toBe(202);
  return ((await response.json()) as { jobId: string }).jobId;
}

async function logs(id: string): Promise<JobMessage[]> {
  return ndjson(await (await call(`/jobs/${id}/logs?follow=1`)).text());
}

type Result = {
  size: number;
  width: number;
  height: number;
  data?: string;
  url?: string;
  path?: string;
  bytes?: number;
};
const results = (messages: JobMessage[]) =>
  messages.flatMap((m) => ("message" in m && m.message ? [m.message as Result] : []));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

describe("binary input, inline base64 output", () => {
  it("resizes an image sent as the raw request body", async () => {
    const messages = await logs(await startRaw("resize", { sizes: SIZES }, IMAGE));
    expect(messages.at(-1)?.status).toBe("done");
    const out = results(messages);
    expect(out.map((r) => [r.size, r.width, r.height])).toEqual([
      [16, 16, 12],
      [8, 8, 6],
    ]);
    for (const r of out) expect(fromBase64(r.data!)).toEqual(expected(r.size));
  });

  it("resizes an image sent as a multipart file", async () => {
    const form = new FormData();
    form.set("params", JSON.stringify({ sizes: [10] }));
    form.set("input", new Blob([IMAGE as BlobPart], { type: "image/x-portable-pixmap" }), "in.ppm");
    const response = await call("/tasks/resize/jobs", { method: "POST", body: form });
    const { jobId } = (await response.json()) as { jobId: string };
    const [r] = results(await logs(jobId));
    expect(fromBase64(r!.data!)).toEqual(expected(10));
  });

  it("resizes an image sent over MCP as inputBase64", async () => {
    const client = new Client({ name: "binary-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://jobs.test/mcp"), {
        fetch: async (url, init) => app.fetch(new Request(url, init)),
      }),
    );
    const base64 = btoa(String.fromCharCode(...IMAGE));
    const started = await client.callTool({
      name: "start_job",
      arguments: { task: "resize", params: { sizes: [8] }, inputBase64: base64 },
    });
    const { jobId } = started.structuredContent as { jobId: string };
    const [r] = results(await logs(jobId));
    expect(fromBase64(r!.data!)).toEqual(expected(8));
    await client.close();
  });
});

describe("results in a separate folder", () => {
  it("reports each result's URL and path; the URL serves the bytes, the path is the file", async () => {
    const id = await startRaw("resize-out", { sizes: SIZES }, IMAGE);
    const out = results(await logs(id));
    expect(out.map((r) => r.url)).toEqual([`/outputs/${id}/16.ppm`, `/outputs/${id}/8.ppm`]);
    for (const r of out) {
      expect(r.path).toBe(join(outputs, id, `${r.size}.ppm`));
      expect(r.bytes).toBe(expected(r.size).length);
      const response = await call(r.url!);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/x-portable-pixmap");
      expect(response.headers.get("content-length")).toBe(String(r.bytes));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected(r.size));
      expect(new Uint8Array(await readFile(r.path!))).toEqual(expected(r.size));
    }
  });

  it("serves nothing outside the job's own folder", async () => {
    const id = await startRaw("resize-out", { sizes: [8] }, IMAGE);
    const other = await startRaw("resize-out", { sizes: [4] }, IMAGE);
    await logs(id);
    await logs(other);
    await writeFile(join(dir.path, "secret.txt"), "secret");
    for (const path of [
      `/outputs/${id}/..%2F..%2Fsecret.txt`,
      `/outputs/${id}/%2e%2e/%2e%2e/secret.txt`,
      `/outputs/${id}/${encodeURIComponent(join(dir.path, "secret.txt"))}`,
      `/outputs/${id}/..%2F${other}%2F4.ppm`,
      `/outputs/${other}/8.ppm`, // that job has no such file
      `/outputs/${id}/missing.ppm`,
      `/outputs/${id}/`,
      "/outputs/not-a-job/8.ppm",
    ]) {
      const response = await call(path);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.text()).not.toContain("secret");
    }
  });

  it("cleanup runs the task's cleanup script, which removes the files and the folder", async () => {
    const id = await startRaw("resize-out", { sizes: SIZES }, IMAGE);
    const out = results(await logs(id));
    expect(await manager.cleanup()).toEqual({ removed: [id], failed: [] });
    for (const r of out) {
      expect(existsSync(r.path!)).toBe(false);
      expect((await call(r.url!)).status).toBe(404);
    }
    expect(existsSync(join(outputs, id))).toBe(false);
  });

  it("a failing cleanup keeps the job and its results", async () => {
    const def = tasks.find((t) => t.name === "resize-out")!;
    manager.setTasks([{ ...def, env: { CLEANUP_FAIL: "1" } }]);
    const id = await startRaw("resize-out", { sizes: [8] }, IMAGE);
    const [r] = results(await logs(id));
    const result = await manager.cleanup();
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([{ id, error: expect.stringContaining("CLEANUP_FAIL") }]);
    expect(existsSync(r!.path!)).toBe(true);
    expect((await call(r!.url!)).status).toBe(200);
    expect(await manager.status(id)).toBe("done");
  });
});

describe("the results folder's environment", () => {
  const envTask = async () => {
    const script = join(dir.path, "env.sh");
    await writeFile(
      script,
      'printf \'{"dir":"%s","url":"%s","exists":%s}\\n\' "$JOB_OUTPUT_DIR" "$JOB_OUTPUT_URL" "$([ -d "$JOB_OUTPUT_DIR" ] && echo true || echo false)"\n',
    );
    return { name: "env", script };
  };

  it("gives each job its own folder, created before the script starts, and its URL", async () => {
    manager.setTasks([await envTask()]);
    const id = await manager.start("env");
    expect(results(await logs(id))).toEqual([
      { dir: join(outputs, id), url: `/outputs/${id}/`, exists: true },
    ]);
  });

  it("sets neither variable and serves no /outputs route when outputs are not configured", async () => {
    const plain = await createJobManager({
      root: join(dir.path, "plain"),
      tasks: [await envTask()],
    });
    const plainApp = createJobsApp(plain);
    try {
      const id = await plain.start("env");
      const messages: JobMessage[] = [];
      for await (const m of plain.logs(id)) messages.push(m);
      expect(results(messages)).toEqual([{ dir: "", url: "", exists: false }]);
      const response = await plainApp.fetch(new Request(`http://jobs.test/outputs/${id}/x`));
      expect(response.status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
