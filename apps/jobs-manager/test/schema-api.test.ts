import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  createJobsApp,
  discoverTasks,
  folderRegistry,
  type ProcessJobManager,
} from "../src/index.ts";
import { SCHEMAS_DIR, tempDir } from "./helpers.ts";
import { ndjson } from "./rest-helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let tasksDir: string;
let manager: ProcessJobManager;
let app: ReturnType<typeof createJobsApp>;

beforeEach(async () => {
  dir = await tempDir();
  tasksDir = join(dir.path, "uploads");
  manager = await createJobManager({
    root: join(dir.path, "jobs"),
    tasks: await discoverTasks(SCHEMAS_DIR),
  });
  const rescan = async () =>
    manager.setTasks([...(await discoverTasks(SCHEMAS_DIR)), ...(await discoverTasks(tasksDir))]);
  app = createJobsApp(manager, { registry: folderRegistry(tasksDir, rescan) });
});

afterEach(async () => {
  await manager.close();
  await dir.remove();
});

const call = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://jobs.test${path}`, init));
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("REST", () => {
  it("answers params that do not match with 400 invalid_params and the issues; no job", async () => {
    const response = await call("/tasks/resize/jobs", json("POST", { sizes: [0] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_params",
        message: expect.stringContaining("/sizes/0"),
        issues: [{ path: "/sizes/0", message: expect.any(String) }],
      },
    });
    expect(await (await call("/jobs")).json()).toEqual([]);
  });

  it("answers a JSONL input with a bad line with 400 naming the line", async () => {
    const response = await call("/tasks/records/jobs", {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: '{"name":"a","amount":1}\n{"name":"b"}\n',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string; issues: unknown[] } };
    expect(body.error.message).toMatch(/line 2/);
    expect(body.error.issues).toEqual([{ path: "/amount", message: expect.any(String) }]);
  });
});

describe("upload with a schema", () => {
  const script = `echo '{"n":"not a number"}'\necho "{\\"n\\":$(echo "$JOB_PARAMS" | wc -c)}"\n`;
  const schema = {
    params: { type: "object", properties: { a: { type: "integer" } }, required: ["a"] },
    message: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
  };

  it("writes <name>.schema.json; the next job is checked by it; removal deletes it", async () => {
    const added = await call("/tasks/typed", json("PUT", { ext: "sh", script, schema }));
    expect(added.status).toBe(201);
    expect((await readdir(tasksDir)).sort()).toEqual(["typed.schema.json", "typed.sh"]);

    const refused = await call("/tasks/typed/jobs", json("POST", {}));
    expect(refused.status).toBe(400);

    const started = await call("/tasks/typed/jobs", json("POST", { a: 1 }));
    const { jobId } = (await started.json()) as { jobId: string };
    const logs = ndjson(await (await call(`/jobs/${jobId}/logs?follow=1`)).text());
    expect(logs).toContainEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "invalid_message" }) }),
    );
    expect(logs).toContainEqual(expect.objectContaining({ message: { n: 8 } }));

    expect((await call("/tasks/typed", { method: "DELETE" })).status).toBe(200);
    expect(await readdir(tasksDir)).toEqual([]);
  });

  it("refuses a schema that does not compile with 400, writing nothing", async () => {
    const response = await call(
      "/tasks/typed",
      json("PUT", { ext: "sh", script, schema: { params: { type: "objekt" } } }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_params", message: expect.stringMatching(/params.*objekt/) },
    });
    expect(await readdir(tasksDir).catch(() => [])).toEqual([]);
  });
});

describe("MCP", () => {
  let client: Client;
  afterEach(async () => client?.close());

  async function connect() {
    client = new Client({ name: "schema-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://jobs.test/mcp"), {
        fetch: async (url, init) => app.fetch(new Request(url, init)),
      }),
    );
  }

  it("reports params that do not match as a tool error naming code and path", async () => {
    await connect();
    const result = await client.callTool({
      name: "start_job",
      arguments: { task: "resize", params: { sizes: ["x"] } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/invalid_params.*\/sizes\/0/);
  });

  it("adds a task with a schema", async () => {
    await connect();
    const added = await client.callTool({
      name: "add_task",
      arguments: { name: "m", ext: "sh", script: "echo 1", schema: { params: { type: "object" } } },
    });
    expect(added.isError).toBeFalsy();
    expect((await readdir(tasksDir)).sort()).toEqual(["m.schema.json", "m.sh"]);
    const refused = await client.callTool({
      name: "start_job",
      arguments: { task: "m", params: 5 },
    });
    expect(JSON.stringify(refused.content)).toMatch(/invalid_params/);
  });
});
