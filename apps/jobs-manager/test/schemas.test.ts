import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  discoverTasks,
  type JobMessage,
  JobsError,
  type Json,
  type ProcessJobManager,
  type TaskDefinition,
} from "../src/index.ts";
import { collect, makePpm, SCHEMAS_DIR, shapes, TASKS_DIR, tempDir } from "./helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let manager: ProcessJobManager;
let tasks: TaskDefinition[];

beforeEach(async () => {
  dir = await tempDir();
  tasks = await discoverTasks(SCHEMAS_DIR);
  manager = await createJobManager({ root: join(dir.path, "jobs"), tasks });
});

afterEach(async () => {
  await manager.close();
  await dir.remove();
});

const bytes = (text: string) => [new TextEncoder().encode(text)];
const run = async (task: string, params?: Json, input?: Iterable<Uint8Array>) =>
  collect(manager.logs(await manager.start(task, params, input)));
const payloads = (messages: JobMessage[]) =>
  messages.flatMap((m) => ("message" in m && m.message !== undefined ? [m.message] : []));

/** The JobsError a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<JobsError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(JobsError);
  return error as JobsError;
}

async function jobCount(): Promise<number> {
  let n = 0;
  for await (const _ of manager.list()) n++;
  return n;
}

describe("discovery", () => {
  it("reads <name>.schema.json into the task definition", async () => {
    const resize = tasks.find((t) => t.name === "resize");
    expect(resize?.schema?.params).toMatchObject({ required: ["sizes"] });
    expect(resize?.schema?.body).toEqual({ contentMediaType: "image/x-portable-pixmap" });
    expect(tasks.find((t) => t.name === "resize-out")?.cleanup).toMatch(/resize-out\.cleanup\.py$/);
    // the helper module in lib/ is not a task
    expect(tasks.map((t) => t.name)).not.toContain("ppm");
  });

  it("skips a task whose schema file is not JSON or not a schema, naming the reason; others load", async () => {
    const folder = join(dir.path, "tasks");
    await mkdir(folder);
    for (const name of ["a", "b", "c", "ok"]) await writeFile(join(folder, `${name}.sh`), "true\n");
    await writeFile(join(folder, "a.schema.json"), "{ not json");
    await writeFile(join(folder, "b.schema.json"), JSON.stringify({ params: { type: "objekt" } }));
    await writeFile(join(folder, "c.schema.json"), JSON.stringify({ params: 5 }));
    const skipped: [string, string][] = [];
    const found = await discoverTasks(folder, undefined, (name, reason) =>
      skipped.push([name, reason]),
    );
    expect(found.map((t) => t.name)).toEqual(["ok"]);
    expect(skipped.map(([name]) => name).sort()).toEqual(["a", "b", "c"]);
    expect(skipped.find(([n]) => n === "a")?.[1]).toMatch(/a\.schema\.json.*JSON/);
    expect(skipped.find(([n]) => n === "b")?.[1]).toMatch(/params.*objekt/);
    expect(skipped.find(([n]) => n === "c")?.[1]).toMatch(/params/);
  });

  it("refuses a task definition with an invalid schema", async () => {
    const bad = {
      name: "bad",
      script: join(TASKS_DIR, "quick.mjs"),
      schema: { params: { type: 1 } },
    };
    expect(() => manager.setTasks([bad as unknown as TaskDefinition])).toThrow(/bad.*params/);
  });
});

describe("params schema", () => {
  it("runs a job whose params match, with JOB_PARAMS as given", async () => {
    const messages = await run("resize", { sizes: [4, 2] }, [makePpm(8, 6)]);
    expect(messages.at(-1)?.status).toBe("done");
    expect(payloads(messages)).toMatchObject([
      { size: 4, width: 4, height: 3 },
      { size: 2, width: 2, height: 2 },
    ]);
  });

  it.each([
    ["a missing required field", {}, "/sizes"],
    ["a wrong type", { sizes: "big" }, "/sizes"],
    ["a value out of range", { sizes: [8, 0] }, "/sizes/1"],
    ["an extra property", { sizes: [8], quality: 9 }, "/"],
    ["null where an object is required", null, "/"],
    ["no params at all", undefined, "/"],
  ])("rejects %s, naming the path, and creates no job", async (_case, params, path) => {
    const error = await rejection(manager.start("resize", params as Json, [makePpm(4, 4)]));
    expect(error.code).toBe("invalid_params");
    expect(error.issues?.map((i) => i.path)).toContain(path);
    expect(error.message).toContain(path);
    expect(await jobCount()).toBe(0);
  });
});

describe("JSONL body schema", () => {
  it("runs a job whose input lines match; blank lines and an empty input are fine", async () => {
    const lines = '{"name":"a","amount":1}\n\n{"name":"b","amount":2.5}\n';
    expect(payloads(await run("records", null, bytes(lines)))).toEqual([{ count: 2, total: 3.5 }]);
    expect(payloads(await run("records", null, bytes("")))).toEqual([{ count: 0, total: 0 }]);
    expect(payloads(await run("records"))).toEqual([{ count: 0, total: 0 }]);
  });

  it("checks lines split across chunks", async () => {
    const chunks = ['{"name":"a","am', 'ount":1}\n{"name":', '"b","amount":2}'];
    expect(
      payloads(
        await run(
          "records",
          null,
          chunks.map((c) => new TextEncoder().encode(c)),
        ),
      ),
    ).toEqual([{ count: 2, total: 3 }]);
  });

  it("rejects an input with a line that is not JSON, naming the line, and keeps nothing", async () => {
    const error = await rejection(
      manager.start("records", null, bytes('{"name":"a","amount":1}\nnot json\n')),
    );
    expect(error.code).toBe("invalid_params");
    expect(error.message).toMatch(/line 2/);
    expect(await jobCount()).toBe(0);
  });

  it("rejects an input with a line that does not match the schema, naming line and path", async () => {
    const input = '{"name":"a","amount":1}\n{"name":"b","amount":2}\n{"name":"c","amount":"3"}\n';
    const error = await rejection(manager.start("records", null, bytes(input)));
    expect(error.message).toMatch(/line 3/);
    expect(error.issues?.map((i) => i.path)).toContain("/amount");
    expect(await jobCount()).toBe(0);
  });

  it("passes any bytes to a task whose body is opaque (contentMediaType only)", async () => {
    // Not an image: the resizer itself reports a typed error that matches its error schema.
    const messages = await run("resize", { sizes: [2] }, bytes("hello"));
    expect(shapes(messages).slice(-2)).toEqual([
      { status: "running", error: { code: "bad_image", detail: expect.any(String) } },
      { status: "error", error: expect.objectContaining({ code: "exit", exitCode: 2 }) },
    ]);
  });
});

describe("message and error schemas", () => {
  it("records non-matching stdout and stderr lines as invalid_message / invalid_error; the exit code decides", async () => {
    const messages = shapes(await run("strict-out"));
    const running = messages.filter((m) => m.status === "running" && Object.keys(m).length > 1);
    const stdout = running.filter(
      (m) =>
        "message" in m || (m as { error?: { code?: string } }).error?.code === "invalid_message",
    );
    const stderr = running.filter((m) => !stdout.includes(m));
    expect(stdout).toEqual([
      { status: "running", message: { n: 1 } },
      {
        status: "running",
        error: {
          code: "invalid_message",
          issues: [expect.objectContaining({ path: "/n" })],
          raw: '{"n":"two"}',
        },
      },
      {
        status: "running",
        error: {
          code: "invalid_message",
          issues: [expect.objectContaining({ path: "/" })],
          raw: "plain text",
        },
      },
    ]);
    expect(stderr).toEqual([
      { status: "running", error: { code: "warn", detail: "low disk" } },
      {
        status: "running",
        error: {
          code: "invalid_error",
          issues: [expect.objectContaining({ path: "/code" })],
          raw: '{"level":"warn"}',
        },
      },
    ]);
    expect(messages.at(-1)).toEqual({ status: "done" });
  });

  it("catches output that breaks the base64 contract", async () => {
    const resize = tasks.find((t) => t.name === "resize")!;
    manager.setTasks([{ ...resize, env: { RESIZE_BROKEN_BASE64: "1" } }]);
    const messages = await run("resize", { sizes: [2] }, [makePpm(4, 4)]);
    const invalid = messages.find(
      (m) => "error" in m && (m.error as { code?: string })?.code === "invalid_message",
    ) as { error: { issues: { path: string }[] } } | undefined;
    expect(invalid?.error.issues.map((i) => i.path)).toEqual(["/data"]);
    expect(payloads(messages)).toEqual([]);
  });

  it("validates nothing a schema leaves out: a params-only task's output passes as is", async () => {
    manager.setTasks([
      {
        name: "count",
        script: join(TASKS_DIR, "count.py"),
        schema: { params: { type: "object" } },
      },
    ]);
    expect(payloads(await run("count", { n: 1 }, bytes("x\n")))).toEqual([
      { bytes: 2, lines: 1, params: { n: 1 } },
    ]);
  });
});

describe("a task that raises", () => {
  it("ends in error by its exit code, with the traceback recorded as invalid_error lines", async () => {
    const messages = shapes(await run("raises"));
    expect(messages).toContainEqual({ status: "running", message: { step: 1 } });
    const invalid = messages.filter(
      (m) => (m as { error?: { code?: string } }).error?.code === "invalid_error",
    ) as unknown as { error: { raw: string } }[];
    expect(invalid[0]?.error.raw).toMatch(/^Traceback/);
    expect(invalid.at(-1)?.error.raw).toBe("ValueError: boom");
    expect(messages.at(-1)).toEqual({
      status: "error",
      error: expect.objectContaining({
        code: "exit",
        exitCode: 1,
        stderr: expect.stringContaining("ValueError: boom"),
      }),
    });
  });
});
