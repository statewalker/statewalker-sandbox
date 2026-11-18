import { spawn } from "node:child_process";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TASKS_DIR, tempDir } from "./helpers.ts";
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
