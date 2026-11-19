import { join } from "node:path";
import { compileErrors, validate } from "@readme/openapi-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  createJobsApp,
  folderOutputs,
  folderRegistry,
  type JobsAppOptions,
  type ProcessJobManager,
} from "../src/index.ts";
import { tempDir } from "./helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let manager: ProcessJobManager;

beforeEach(async () => {
  dir = await tempDir();
  manager = await createJobManager({ root: join(dir.path, "jobs"), tasks: [] });
});

afterEach(async () => {
  await manager.close();
  await dir.remove();
});

type Doc = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
};

async function documentOf(options: JobsAppOptions = {}, path = "/openapi.json"): Promise<Doc> {
  const app = createJobsApp(manager, options);
  const response = await app.fetch(new Request(`http://jobs.test${path}`));
  expect(response.status).toBe(200);
  return (await response.json()) as Doc;
}

const operations = (doc: Doc) =>
  Object.entries(doc.paths)
    .flatMap(([path, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`))
    .sort();

describe("OpenAPI document", () => {
  it("is a valid OpenAPI 3.1 document covering every route", async () => {
    const doc = await documentOf({
      registry: folderRegistry(join(dir.path, "tasks")),
      outputs: folderOutputs(join(dir.path, "outputs")),
    });
    const result = await validate(structuredClone(doc) as never);
    expect(result.valid, result.valid ? "" : compileErrors(result)).toBe(true);
    expect(doc.openapi).toBe("3.1.0");
    expect(operations(doc)).toEqual([
      "DELETE /jobs/{id}",
      "DELETE /tasks/{name}",
      "GET /jobs",
      "GET /jobs/{id}",
      "GET /jobs/{id}/events",
      "GET /jobs/{id}/logs",
      "GET /outputs/{id}/{path}",
      "GET /tasks",
      "POST /cleanup",
      "POST /mcp",
      "POST /tasks/{task}/jobs",
      "PUT /tasks/{name}",
    ]);
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(["Error", "Issue", "JobInfo", "JobMessage", "TaskInfo", "TaskSchema"]),
    );
  });

  it("describes the job-start body in its three forms and the streams' items", async () => {
    const doc = await documentOf();
    const start = doc.paths["/tasks/{task}/jobs"]?.post as {
      requestBody: { content: Record<string, unknown> };
    };
    expect(Object.keys(start.requestBody.content)).toEqual([
      "application/json",
      "multipart/form-data",
      "application/octet-stream",
    ]);
    const logs = doc.paths["/jobs/{id}/logs"]?.get as {
      responses: { 200: { content: Record<string, { schema: unknown }> } };
    };
    expect(logs.responses[200].content["application/x-ndjson"]?.schema).toEqual({
      $ref: "#/components/schemas/JobMessage",
    });
  });

  it("leaves out the routes that are off: outputs and MCP", async () => {
    const ops = operations(await documentOf({ mcp: false }));
    expect(ops).not.toContain("GET /outputs/{id}/{path}");
    expect(ops).not.toContain("POST /mcp");
  });

  it("lives under the base path, with the paths prefixed", async () => {
    const doc = await documentOf({ basePath: "/api" }, "/api/openapi.json");
    expect(operations(doc)).toContain("GET /api/jobs/{id}");
  });
});

describe("request validation from the same schemas", () => {
  it("keeps the invalid_params error shape, with issues", async () => {
    const app = createJobsApp(manager, { registry: folderRegistry(join(dir.path, "tasks")) });
    const response = await app.fetch(
      new Request("http://jobs.test/tasks/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ext: 5, script: "true" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_params",
        message: expect.stringContaining("/ext"),
        issues: [{ path: "/ext", message: expect.any(String) }],
      },
    });
  });

  it("answers a body that is not JSON with 400 invalid_params", async () => {
    const app = createJobsApp(manager, { registry: folderRegistry(join(dir.path, "tasks")) });
    const response = await app.fetch(
      new Request("http://jobs.test/tasks/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{ nope",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_params" } });
  });
});
