import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  encodePpm,
  makePpm,
  parsePpm,
  resizeNearest,
  SCHEMAS_DIR,
  TASKS_DIR,
  tempDir,
} from "./helpers.ts";
import { ndjson } from "./rest-helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => (dir = await tempDir()));
afterEach(async () => dir.remove());

it("serves the tasks of a directory over HTTP and shuts down on SIGTERM", async () => {
  const cli = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "../src/cli.ts"),
      "serve",
      "--tasks",
      TASKS_DIR,
      "--data",
      dir.path,
      "--port",
      "0",
      "--host",
      "127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: cli.stdout! })[Symbol.asyncIterator]();
  const first = String((await lines.next()).value);
  const base = /listening on (http:\/\/\S+)/.exec(first)?.[1];
  expect(base).toBeDefined();

  const tasks = (await (await fetch(`${base}/tasks`)).json()) as {
    name: string;
    hasCleanup: boolean;
  }[];
  expect(tasks).toContainEqual({ name: "image-generator", hasCleanup: true });
  // by default: MCP is served, task upload is refused, no CORS headers
  const mcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(mcp.status).not.toBe(404);
  const upload = await fetch(`${base}/tasks/x`, {
    method: "PUT",
    body: '{"ext":"sh","script":"true"}',
  });
  expect(upload.status).toBe(403);
  expect(upload.headers.get("access-control-allow-origin")).toBeNull();

  const submitted = await fetch(`${base}/tasks/quick/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"from":"cli"}',
  });
  const { logsUrl } = (await submitted.json()) as { logsUrl: string };
  const logs = ndjson(await (await fetch(`${base}${logsUrl}?follow=1`)).text());
  expect(logs.at(-1)?.status).toBe("done");

  cli.kill("SIGTERM");
  const [code] = await once(cli, "exit");
  expect(code).toBe(0);
});

it("creates a missing tasks directory and serves it, empty at first", async () => {
  const tasksDir = join(dir.path, "tasks");
  const cli = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "../src/cli.ts"),
      "serve",
      "--tasks",
      tasksDir,
      "--data",
      join(dir.path, "data"),
      "--port",
      "0",
      "--host",
      "127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: cli.stdout! })[Symbol.asyncIterator]();
  const base = /listening on (http:\/\/\S+)/.exec(String((await lines.next()).value))?.[1];
  expect(base).toBeDefined();
  expect(await (await fetch(`${base}/tasks`)).json()).toEqual([]);
  expect((await stat(tasksDir)).isDirectory()).toBe(true);

  cli.kill("SIGTERM");
  const [code] = await once(cli, "exit");
  expect(code).toBe(0);
});

it("accepts task uploads with --allow-task-upload, drops MCP with --no-mcp, sends CORS with --cors", async () => {
  const tasksDir = join(dir.path, "tasks");
  const cli = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "../src/cli.ts"),
      "serve",
      "--tasks",
      tasksDir,
      "--data",
      join(dir.path, "data"),
      "--port",
      "0",
      "--host",
      "127.0.0.1",
      "--allow-task-upload",
      "--no-mcp",
      "--cors",
      "http://ui.test,http://other.test",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: cli.stdout! })[Symbol.asyncIterator]();
  const base = /listening on (http:\/\/\S+)/.exec(String((await lines.next()).value))?.[1];
  expect(base).toBeDefined();

  const upload = await fetch(`${base}/tasks/hello`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "http://ui.test" },
    body: JSON.stringify({ ext: "sh", script: `echo '{"hi":1}'` }),
  });
  expect(upload.status).toBe(201);
  expect(upload.headers.get("access-control-allow-origin")).toBe("http://ui.test");
  expect(await (await fetch(`${base}/tasks`)).json()).toEqual([
    { name: "hello", hasCleanup: false },
  ]);
  expect((await stat(join(tasksDir, "hello.sh"))).isFile()).toBe(true);
  expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(404);

  cli.kill("SIGTERM");
  const [code] = await once(cli, "exit");
  expect(code).toBe(0);
});

it("serves results with --outputs, the OpenAPI document, and names the tasks it skips", async () => {
  const tasksDir = join(dir.path, "tasks");
  await cp(join(SCHEMAS_DIR, "lib"), join(tasksDir, "lib"), { recursive: true });
  for (const file of ["resize-out.py", "resize-out.cleanup.py", "resize-out.schema.json"])
    await cp(join(SCHEMAS_DIR, file), join(tasksDir, file));
  await writeFile(join(tasksDir, "bad.sh"), "true\n");
  await writeFile(join(tasksDir, "bad.schema.json"), "{ not json");
  const outputs = join(dir.path, "results");
  const cli = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "../src/cli.ts"),
      "serve",
      "--tasks",
      tasksDir,
      "--data",
      join(dir.path, "data"),
      "--outputs",
      outputs,
      "--base-path",
      "/api/", // a trailing slash must not leak into the URLs tasks report
      "--port",
      "0",
      "--host",
      "127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  cli.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  try {
    const lines = createInterface({ input: cli.stdout! })[Symbol.asyncIterator]();
    const base = /listening on (http:\/\/\S+)/.exec(String((await lines.next()).value))?.[1];
    expect(base).toBeDefined();
    const origin = new URL(base!).origin;

    expect(await (await fetch(`${base}/tasks`)).json()).toEqual([
      { name: "resize-out", hasCleanup: true },
    ]);
    expect(stderr).toMatch(/skipped task bad: .*bad\.schema\.json.*JSON/);
    expect(stderr).toContain(`outputs in ${outputs}`);
    expect((await (await fetch(`${base}/openapi.json`)).json()).openapi).toBe("3.1.0");

    const started = await fetch(
      `${base}/tasks/resize-out/jobs?params=${encodeURIComponent('{"sizes":[6]}')}`,
      {
        method: "POST",
        headers: { "content-type": "image/x-portable-pixmap" },
        body: makePpm(12, 8) as BodyInit,
      },
    );
    const { jobId } = (await started.json()) as { jobId: string };
    const messages = ndjson(await (await fetch(`${base}/jobs/${jobId}/logs?follow=1`)).text());
    const found = messages.find((m) => "message" in m && m.message);
    const result = (found as unknown as { message: { url: string } }).message;
    expect(result.url).toBe(`/api/outputs/${jobId}/6.ppm`);
    const image = await fetch(new URL(result.url, origin));
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(
      encodePpm(resizeNearest(parsePpm(makePpm(12, 8)), 6)),
    );

    const cleaned = await (await fetch(`${base}/cleanup`, { method: "POST" })).json();
    expect(cleaned).toEqual({ removed: [jobId], failed: [] });
    expect((await fetch(new URL(result.url, origin))).status).toBe(404);
  } finally {
    cli.kill("SIGTERM");
    await once(cli, "exit");
  }
});
