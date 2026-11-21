import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  createJobsHandler,
  type ProcessJobManager,
  type Server,
  serve,
} from "../src/index.ts";
import { shapes, task, tempDir } from "./helpers.ts";
import { ndjson, readSse } from "./rest-helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let manager: ProcessJobManager;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = await tempDir();
  manager = await createJobManager({
    root: dir.path,
    tasks: [
      task("quick", "quick.mjs"),
      task("fail", "fail.sh"),
      task("count", "count.py"),
      task("sleepy", "sleepy.sh"),
    ],
  });
  server = await serve(createJobsHandler(manager), { port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
  await manager.close();
  await dir.remove();
});

async function submit(taskName: string, init: RequestInit = {}, query = "") {
  const response = await fetch(`${base}/tasks/${taskName}/jobs${query}`, {
    method: "POST",
    ...init,
  });
  return {
    response,
    body: (await response.json()) as Record<string, string> & { error?: { code: string } },
  };
}

async function finished(jobId: string) {
  return ndjson(await (await fetch(`${base}/jobs/${jobId}/logs?follow=1`)).text());
}

describe("REST API", () => {
  it("lists the registered tasks", async () => {
    const response = await fetch(`${base}/tasks`);
    expect(await response.json()).toEqual([
      { name: "quick", hasCleanup: false },
      { name: "fail", hasCleanup: false },
      { name: "count", hasCleanup: false },
      { name: "sleepy", hasCleanup: false },
    ]);
  });

  it("starts a job from JSON params and answers 202 with the job's URLs", async () => {
    const { response, body } = await submit("quick", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ size: 2 }),
    });
    expect(response.status).toBe(202);
    const id = body.jobId;
    expect(body).toEqual({
      jobId: id,
      statusUrl: `/jobs/${id}`,
      logsUrl: `/jobs/${id}/logs`,
      eventsUrl: `/jobs/${id}/events`,
    });
    expect(response.headers.get("location")).toBe(`/jobs/${id}`);

    expect(shapes(await finished(id))).toEqual([
      { status: "pending" },
      { status: "running" },
      { status: "running", message: { hello: "world", params: { size: 2 }, jobId: id } },
      { status: "done" },
    ]);
    const info = await (await fetch(`${base}${body.statusUrl}`)).json();
    expect(info).toMatchObject({ id, task: "quick", params: { size: 2 }, status: "done" });
  });

  it("streams a raw request body to the script's stdin, with params in the query", async () => {
    const params = encodeURIComponent(JSON.stringify({ via: "query" }));
    const { body } = await submit(
      "count",
      { headers: { "content-type": "application/octet-stream" }, body: "line 1\nline 2\nline 3\n" },
      `?params=${params}`,
    );
    const message = (await finished(body.jobId)).find((m) => "message" in m);
    expect(message).toMatchObject({ message: { bytes: 21, lines: 3, params: { via: "query" } } });
  });

  it("accepts multipart form data with a params field and an input file", async () => {
    const form = new FormData();
    form.set("params", JSON.stringify({ via: "multipart" }));
    form.set("input", new Blob(["a\nb\n"]), "input.txt");
    const { body } = await submit("count", { body: form });
    const message = (await finished(body.jobId)).find((m) => "message" in m);
    expect(message).toMatchObject({
      message: { bytes: 4, lines: 2, params: { via: "multipart" } },
    });
  });

  it("returns a snapshot of the logs by default and resumes after ?since", async () => {
    const { body } = await submit("fail", {
      headers: { "content-type": "application/json" },
      body: "null",
    });
    const all = await finished(body.jobId);
    const rest = ndjson(
      await (await fetch(`${base}/jobs/${body.jobId}/logs?since=${all[3].stamp}`)).text(),
    );
    expect(rest).toEqual(all.slice(4));
  });

  it("streams progress as server-sent events, ending after the final status", async () => {
    const { body } = await submit("fail", {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const response = await fetch(`${base}${body.eventsUrl}`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = await readSse(response);
    expect(events.map((e) => e.data.status)).toEqual([
      "pending",
      "running",
      "running",
      "running",
      "running",
      "error",
    ]);
    expect(events.every((e) => e.id === String(e.data.stamp))).toBe(true);

    const resumed = await readSse(
      await fetch(`${base}${body.eventsUrl}`, { headers: { "last-event-id": events[2].id! } }),
    );
    expect(resumed).toEqual(events.slice(3));
  });

  it("interrupts a running job on DELETE", async () => {
    const { body } = await submit("sleepy", {
      headers: { "content-type": "application/json" },
      body: "null",
    });
    await readSse(await fetch(`${base}${body.eventsUrl}`), (e) => "message" in e.data);
    const response = await fetch(`${base}/jobs/${body.jobId}`, { method: "DELETE" });
    expect(await response.json()).toEqual({ id: body.jobId, status: "interrupted" });
  });

  it("lists jobs, filtered by status and task", async () => {
    const a = (
      await submit("quick", { headers: { "content-type": "application/json" }, body: "1" })
    ).body.jobId;
    const b = (await submit("fail", { headers: { "content-type": "application/json" }, body: "2" }))
      .body.jobId;
    await finished(a);
    await finished(b);
    const ids = async (query: string) =>
      ((await (await fetch(`${base}/jobs${query}`)).json()) as { id: string }[])
        .map((j) => j.id)
        .sort();
    expect(await ids("")).toEqual([a, b].sort());
    expect(await ids("?status=error,interrupted")).toEqual([b]);
    expect(await ids("?task=quick")).toEqual([a]);
  });

  it("cleans up finished jobs on POST /cleanup", async () => {
    const { body } = await submit("quick", {
      headers: { "content-type": "application/json" },
      body: "null",
    });
    await finished(body.jobId);
    const response = await fetch(`${base}/cleanup`, { method: "POST" });
    expect(await response.json()).toEqual({ removed: [body.jobId], failed: [] });
    expect((await fetch(`${base}/jobs/${body.jobId}`)).status).toBe(404);
  });

  it("answers errors as JSON with a code", async () => {
    const unknownTask = await submit("nope", {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect([unknownTask.response.status, unknownTask.body.error?.code]).toEqual([
      404,
      "unknown_task",
    ]);

    const badParams = await submit("quick", {
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect([badParams.response.status, badParams.body.error?.code]).toEqual([
      400,
      "invalid_params",
    ]);

    const missing = await fetch(`${base}/jobs/00000000-0000-0000-0000-000000000000/events`);
    expect([
      missing.status,
      ((await missing.json()) as { error: { code: string } }).error.code,
    ]).toEqual([404, "unknown_job"]);

    const traversal = await fetch(`${base}/jobs/..%2F..%2Fetc`);
    expect(traversal.status).toBe(404);

    // Regression: a non-numeric cut-off must not mean "delete everything".
    const badBefore = await fetch(`${base}/cleanup?before=yesterday`, { method: "POST" });
    expect([
      badBefore.status,
      ((await badBefore.json()) as { error: { code: string } }).error.code,
    ]).toEqual([400, "invalid_params"]);
    const badSince = await fetch(
      `${base}/jobs/00000000-0000-0000-0000-000000000000/logs?since=abc`,
    );
    expect(badSince.status).toBe(400);

    const route = await fetch(`${base}/nowhere`);
    expect([
      route.status,
      ((await route.json()) as { error: { code: string } }).error.code,
    ]).toEqual([404, "not_found"]);
  });
});
