import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMAS_DIR, TASKS_DIR, tempDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "../src/cli.ts");

let dir: Awaited<ReturnType<typeof tempDir>>;
let tasksDir: string;
let server: ChildProcess;
let url: string;

type Result = { code: number | null; stdout: string; stderr: string };

/** Runs `jobs <args>` against the test server. */
async function jobs(
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Promise<Result> {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, JOBS_URL: url, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdin.end(options.input ?? "");
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

const jsonl = (text: string) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

beforeAll(async () => {
  dir = await tempDir();
  tasksDir = join(dir.path, "tasks");
  await cp(TASKS_DIR, tasksDir, { recursive: true });
  server = spawn(
    process.execPath,
    [
      CLI,
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
  const first = await createInterface({ input: server.stdout as NodeJS.ReadableStream })
    [Symbol.asyncIterator]()
    .next();
  url = /listening on (http:\/\/\S+)/.exec(String(first.value))?.[1] ?? "";
  expect(url).not.toBe("");
});

afterAll(async () => {
  server.kill("SIGTERM");
  await once(server, "exit");
  await dir.remove();
});

describe("jobs tasks", () => {
  it("lists the server's tasks, as text or JSON", async () => {
    const text = await jobs(["tasks"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^image-generator\s+\(\+cleanup\)$/m);
    expect(text.stdout).toMatch(/^quick$/m);

    const json = await jobs(["tasks", "--json"]);
    expect(JSON.parse(json.stdout)).toContainEqual({ name: "count", hasCleanup: false });
  });

  it("adds a task from a script file, which the running server picks up, and removes it", async () => {
    const script = join(dir.path, "hello.sh");
    await writeFile(script, 'echo "{\\"greeting\\":$JOB_PARAMS}"\n');
    const cleanup = join(dir.path, "hello.cleanup.sh");
    await writeFile(cleanup, "exit 0\n");

    const added = await jobs([
      "tasks",
      "add",
      script,
      "--name",
      "greet",
      "--cleanup",
      cleanup,
      "--tasks",
      tasksDir,
    ]);
    expect(added.code).toBe(0);
    expect((await readdir(tasksDir)).filter((f) => f.startsWith("greet"))).toEqual([
      "greet.cleanup.sh",
      "greet.sh",
    ]);
    expect((await jobs(["tasks"])).stdout).toMatch(/^greet\s+\(\+cleanup\)$/m);

    const run = await jobs(["start", "greet", "--params", '"world"', "--wait"]);
    expect(run.code).toBe(0);
    const id = run.stdout.trim();
    expect(jsonl((await jobs(["result", id])).stdout)).toEqual([{ greeting: "world" }]);

    expect((await jobs(["tasks", "remove", "greet", "--tasks", tasksDir])).code).toBe(0);
    expect((await jobs(["tasks"])).stdout).not.toMatch(/^greet/m);
  });

  it("refuses to overwrite an existing task", async () => {
    const add = await jobs(["tasks", "add", join(TASKS_DIR, "quick.mjs"), "--tasks", tasksDir]);
    expect(add.code).toBe(3);
    expect(add.stderr).toMatch(/already exists/);
  });
});

describe("jobs start / wait / result", () => {
  it("starts a job with -p key=value params, waits for it and prints its id", async () => {
    const run = await jobs([
      "start",
      "quick",
      "-p",
      "size=3",
      "-p",
      "name=box",
      "-p",
      'tags=["a"]',
      "--wait",
    ]);
    expect(run.code).toBe(0);
    const id = run.stdout.trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.stderr).toMatch(/done/);
    expect(jsonl((await jobs(["result", id])).stdout)).toEqual([
      { hello: "world", params: { size: 3, name: "box", tags: ["a"] }, jobId: id },
    ]);
  });

  it("sends a file or stdin as the job's input", async () => {
    const file = join(dir.path, "lines.txt");
    await writeFile(file, "one\ntwo\nthree\n");
    const fromFile = await jobs(["start", "count", "--input", file, "--wait"]);
    expect(jsonl((await jobs(["result", fromFile.stdout.trim()])).stdout)[0]).toMatchObject({
      bytes: 14,
      lines: 3,
    });

    const fromStdin = await jobs(["start", "count", "--input", "-", "--wait"], { input: "x\ny\n" });
    expect(jsonl((await jobs(["result", fromStdin.stdout.trim(), "--last"])).stdout)).toEqual([
      { bytes: 4, lines: 2, params: null },
    ]);
  });

  it("exits 1 when the job fails and shows why", async () => {
    const run = await jobs(["start", "fail", "--wait"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/error/);
    expect(run.stderr).toMatch(/exit.*3/);
  });

  it("follows a job's messages while it runs", async () => {
    const run = await jobs([
      "start",
      "stream",
      "-p",
      "seconds=1",
      "-p",
      "intervalMs=250",
      "--follow",
      "--json",
    ]);
    expect(run.code).toBe(0);
    const [id, ...lines] = run.stdout.trim().split("\n");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const messages = lines.map((l) => JSON.parse(l));
    expect(messages.filter((m) => "message" in m).map((m) => m.message.tick)).toEqual([1, 2, 3, 4]);
    expect(messages.at(-1).status).toBe("done");
  });
});

describe("jobs start with a task schema", () => {
  it("exits 3 naming the issue when params or input lines do not match; runs when they do", async () => {
    await cp(join(SCHEMAS_DIR, "lib"), join(tasksDir, "lib"), { recursive: true });
    for (const file of ["records.py", "records.schema.json", "resize.py", "resize.schema.json"])
      await cp(join(SCHEMAS_DIR, file), join(tasksDir, file));

    const badParams = await jobs(["start", "resize", "-p", "sizes=[0]"]);
    expect(badParams.code).toBe(3);
    expect(badParams.stderr).toMatch(/invalid_params|params.*\/sizes\/0/);
    expect(badParams.stderr).toMatch(/\/sizes\/0/);

    const badLine = await jobs(["start", "records", "--input", "-"], { input: "{}\n" });
    expect(badLine.code).toBe(3);
    expect(badLine.stderr).toMatch(/line 1/);

    const ok = await jobs(["start", "records", "--input", "-", "--wait"], {
      input: '{"name":"a","amount":2}\n',
    });
    expect(ok.code).toBe(0);
    expect(jsonl((await jobs(["result", ok.stdout.trim()])).stdout)).toEqual([
      { count: 1, total: 2 },
    ]);
  });
});

describe("jobs status / logs / interrupt / wait / list", () => {
  it("interrupts a running job; wait then exits 2", async () => {
    const id = (await jobs(["start", "sleepy"])).stdout.trim();
    const logs = await jobs(["logs", id, "--follow", "--until-message"]);
    expect(logs.stdout).toMatch(/running/);

    const interrupted = await jobs(["interrupt", id]);
    expect(interrupted.stdout.trim()).toBe("interrupted");
    expect((await jobs(["status", id])).stdout.trim()).toBe("interrupted");
    expect((await jobs(["wait", id])).code).toBe(2);
  });

  // Review finding (PR #160): a timeout that fires before the server answers crashed with exit 1.
  it("wait --timeout gives up with exit 124 even before the server has answered", async () => {
    const id = (await jobs(["start", "sleepy"])).stdout.trim();
    const timedOut = await jobs(["wait", id, "--timeout", "0"]);
    expect([timedOut.code, timedOut.stderr]).toEqual([124, expect.stringMatching(/^still /)]);
    expect((await jobs(["interrupt", id])).stdout.trim()).toBe("interrupted");
  });

  it("prints logs as readable lines or JSONL, resumable with --since", async () => {
    const id = (await jobs(["start", "fail", "--wait"])).stdout.trim();
    const text = (await jobs(["logs", id])).stdout;
    expect(text).toMatch(/^\S+ +pending$/m);
    expect(text).toMatch(/^\S+ +running +stderr +boom: something broke$/m);
    const all = jsonl((await jobs(["logs", id, "--json"])).stdout);
    expect(all.at(-1).status).toBe("error");
    const rest = jsonl(
      (await jobs(["logs", id, "--json", "--since", String(all[2].stamp)])).stdout,
    );
    expect(rest).toEqual(all.slice(3));
  });

  it("shows a job's details and lists jobs with filters", async () => {
    const id = (await jobs(["start", "quick", "--wait"])).stdout.trim();
    expect(JSON.parse((await jobs(["info", id])).stdout)).toMatchObject({
      id,
      task: "quick",
      status: "done",
    });

    const listed = JSON.parse(
      (await jobs(["list", "--status", "done", "--task", "quick", "--json"])).stdout,
    );
    expect(listed.map((j: { id: string }) => j.id)).toContain(id);
    const table = (await jobs(["list"])).stdout;
    expect(table).toMatch(new RegExp(`^${id}\\s+quick\\s+done\\s`, "m"));
  });
});

describe("jobs verify", () => {
  it("checks status and results; exits 0 on success and 1 with the failures", async () => {
    const id = (await jobs(["start", "quick", "-p", "size=2", "--wait"])).stdout.trim();
    const good = await jobs([
      "verify",
      id,
      "--status",
      "done",
      "--count",
      "1",
      "--contains",
      '{"hello":"world"}',
    ]);
    expect([good.code, good.stdout.trim()]).toEqual([0, "ok"]);

    const bad = await jobs(["verify", id, "--status", "error", "--contains", '{"hello":"mars"}']);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/status: expected error, got done/);
    expect(bad.stdout).toMatch(/contains: no result message matches \{"hello":"mars"\}/);
  });

  it("compares the results with an expected JSONL file", async () => {
    const id = (
      await jobs(["start", "count", "--input", "-", "--wait"], { input: "a\n" })
    ).stdout.trim();
    const expected = join(dir.path, "expected.jsonl");
    await writeFile(expected, '{"bytes":2,"lines":1,"params":null}\n');
    expect((await jobs(["verify", id, "--expect", expected])).code).toBe(0);
    await writeFile(expected, '{"bytes":3,"lines":1,"params":null}\n');
    expect((await jobs(["verify", id, "--expect", expected])).code).toBe(1);
  });
});

describe("jobs cleanup and errors", () => {
  it("cleans up finished jobs older than a duration", async () => {
    const id = (await jobs(["start", "quick", "--wait"])).stdout.trim();
    const kept = await jobs(["cleanup", "--older-than", "1h"]);
    expect(kept.stdout).toMatch(/removed 0/);
    const removed = await jobs(["cleanup", "--older-than", "0s", "--json"]);
    expect(JSON.parse(removed.stdout).removed).toContain(id);
    const gone = await jobs(["status", id]);
    expect(gone.code).toBe(3);
    expect(gone.stderr).toMatch(/unknown_job/);
  });

  it("explains a server that cannot be reached", async () => {
    const r = await jobs(["tasks"], { env: { JOBS_URL: "http://127.0.0.1:9" } });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/cannot reach http:\/\/127\.0\.0\.1:9/);
  });

  it("prints usage for help, and for an unknown command with exit 3", async () => {
    const help = await jobs(["help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/jobs start <task>/);
    const unknown = await jobs(["frobnicate"]);
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toMatch(/unknown command: frobnicate/);
  });
});

describe("jobs output into a closed pipe", () => {
  it("stops quietly when the reader closes stdout early, like `| head -1`", async () => {
    const id = (
      await jobs(["start", "count", "--input", "-", "--wait"], { input: "a\n" })
    ).stdout.trim();
    const child = spawn(process.execPath, [CLI, "logs", id, "--json"], {
      env: { ...process.env, JOBS_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.stdout.destroy(); // the reader is gone before the first line is written
    const [code] = await once(child, "close");
    expect(stderr).not.toMatch(/EPIPE|Unhandled/);
    expect(code).toBe(0);
  });
});
