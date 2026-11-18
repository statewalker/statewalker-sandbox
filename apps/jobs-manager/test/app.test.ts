import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  createJobsApp,
  discoverTasks,
  folderRegistry,
  type ProcessJobManager,
} from "../src/index.ts";
import { tempDir } from "./helpers.ts";
import { ndjson } from "./rest-helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let tasksDir: string;
let manager: ProcessJobManager;

beforeEach(async () => {
  dir = await tempDir();
  tasksDir = join(dir.path, "tasks");
  manager = await createJobManager({ root: join(dir.path, "jobs"), tasks: [] });
});

afterEach(async () => {
  await manager.close();
  await dir.remove();
});

const registry = () =>
  folderRegistry(tasksDir, async () => manager.setTasks(await discoverTasks(tasksDir)));

const call = (
  app: { fetch: (r: Request) => Response | Promise<Response> },
  path: string,
  init?: RequestInit,
) => app.fetch(new Request(`http://jobs.test${path}`, init));

const put = (body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("task upload", () => {
  it("adds a task the next listing shows and a job can run, then removes it", async () => {
    const app = createJobsApp(manager, { registry: registry() });

    const added = await call(app, "/tasks/hello", put({ ext: "sh", script: `echo '{"hi":1}'` }));
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({ name: "hello", hasCleanup: false });
    expect(await (await call(app, "/tasks")).json()).toEqual([
      { name: "hello", hasCleanup: false },
    ]);

    const { jobId } = (await (
      await call(app, "/tasks/hello/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      })
    ).json()) as { jobId: string };
    const logs = ndjson(await (await call(app, `/jobs/${jobId}/logs?follow=1`)).text());
    expect(logs.at(-1)?.status).toBe("done");
    expect(logs).toContainEqual(expect.objectContaining({ message: { hi: 1 } }));

    const removed = await call(app, "/tasks/hello", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await (await call(app, "/tasks")).json()).toEqual([]);
  });

  it("adds a cleanup script with the same extension", async () => {
    const app = createJobsApp(manager, { registry: registry() });
    const added = await call(
      app,
      "/tasks/t",
      put({ ext: "py", script: "print(1)", cleanup: "pass" }),
    );
    expect(await added.json()).toEqual({ name: "t", hasCleanup: true });
  });

  it("rejects a bad upload with 400 and an unknown task with 404", async () => {
    const app = createJobsApp(manager, { registry: registry() });
    const noLauncher = await call(app, "/tasks/x", put({ ext: "exe", script: "" }));
    expect(noLauncher.status).toBe(400);
    expect(await noLauncher.json()).toMatchObject({ error: { code: "invalid_params" } });

    await call(app, "/tasks/x", put({ ext: "sh", script: "true" }));
    const twice = await call(app, "/tasks/x", put({ ext: "sh", script: "true" }));
    expect(twice.status).toBe(400);

    const badName = await call(app, "/tasks/a.b", put({ ext: "sh", script: "true" }));
    expect(badName.status).toBe(400);

    const missing = await call(app, "/tasks/nope", { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "unknown_task" } });
  });

  it("refuses upload and removal with 403 when no registry is given", async () => {
    const app = createJobsApp(manager);
    for (const init of [put({ ext: "sh", script: "true" }), { method: "DELETE" }]) {
      const response = await call(app, "/tasks/x", init);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "task_upload_disabled" } });
    }
  });
});

describe("CORS", () => {
  const preflight = (origin: string) =>
    ({
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,mcp-protocol-version",
      },
    }) satisfies RequestInit;

  it("answers preflights from allowed origins for REST routes and /mcp, and only those", async () => {
    const app = createJobsApp(manager, { cors: { origin: ["http://ui.test"] } });
    for (const path of ["/tasks", "/mcp"]) {
      const allowed = await call(app, path, preflight("http://ui.test"));
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://ui.test");
      expect(allowed.headers.get("access-control-allow-headers")).toMatch(/mcp-protocol-version/);
      const other = await call(app, path, preflight("http://evil.test"));
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
    }
    const get = await call(app, "/tasks", { headers: { origin: "http://ui.test" } });
    expect(get.headers.get("access-control-allow-origin")).toBe("http://ui.test");
    expect(get.headers.get("access-control-expose-headers")).toMatch(/location/);
  });

  it("allows every origin with *", async () => {
    const app = createJobsApp(manager, { cors: { origin: "*" } });
    const response = await call(app, "/tasks", preflight("http://any.test"));
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("sends no CORS headers unless configured", async () => {
    const app = createJobsApp(manager);
    const response = await call(app, "/tasks", { headers: { origin: "http://ui.test" } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("MCP route", () => {
  it("is not mounted with mcp: false", async () => {
    const app = createJobsApp(manager, { mcp: false });
    expect((await call(app, "/mcp", { method: "POST" })).status).toBe(404);
  });

  it("lives under the base path", async () => {
    const app = createJobsApp(manager, { basePath: "/api" });
    expect((await call(app, "/api/mcp", { method: "GET" })).status).not.toBe(404);
    expect((await call(app, "/mcp", { method: "GET" })).status).toBe(404);
  });
});
