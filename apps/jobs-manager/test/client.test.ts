import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  createJobsHandler,
  JobsClient,
  type ProcessJobManager,
  type Server,
  serve,
} from "../src/index.ts";
import { collect, shapes, task, tempDir } from "./helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let manager: ProcessJobManager;
let server: Server;
let client: JobsClient;

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
  server = await serve(createJobsHandler(manager, { basePath: "/api" }), {
    port: 0,
    host: "127.0.0.1",
  });
  client = new JobsClient(`http://127.0.0.1:${server.port}/api`);
});

afterEach(async () => {
  await server.close();
  await manager.close();
  await dir.remove();
});

describe("JobsClient: the JobManager interface over HTTP", () => {
  it("lists tasks", async () => {
    expect((await client.tasks()).map((t) => t.name)).toEqual(["quick", "fail", "count", "sleepy"]);
  });

  it("starts a job and follows its logs to the end", async () => {
    const id = await client.start("quick", { size: 1 });
    expect(shapes(await collect(client.logs(id)))).toEqual([
      { status: "pending" },
      { status: "running" },
      { status: "running", message: { hello: "world", params: { size: 1 }, jobId: id } },
      { status: "done" },
    ]);
    expect(await client.status(id)).toBe("done");
    expect(await client.info(id)).toMatchObject({ id, task: "quick", params: { size: 1 } });
  });

  it("streams an input to the script", async () => {
    const id = await client.start("count", { k: 1 }, [new TextEncoder().encode("a\nb\n")]);
    const message = (await collect(client.logs(id))).find((m) => "message" in m);
    expect(message).toMatchObject({ message: { bytes: 4, lines: 2, params: { k: 1 } } });
  });

  it("returns a snapshot without following, and resumes after a stamp", async () => {
    const id = await client.start("fail", null);
    const all = await collect(client.logs(id));
    expect(await collect(client.logs(id, all[2].stamp, { follow: false }))).toEqual(all.slice(3));
  });

  it("interrupts, lists with filters and cleans up", async () => {
    const id = await client.start("sleepy", null);
    for await (const m of client.logs(id)) if ("message" in m) break;
    expect(await client.interrupt(id)).toBe("interrupted");
    const listed = [];
    for await (const info of client.list({ status: "interrupted" })) listed.push(info.id);
    expect(listed).toEqual([id]);
    expect(await client.cleanup()).toEqual({ removed: [id], failed: [] });
  });

  it("raises JobsError codes from the server", async () => {
    await expect(client.start("nope", null)).rejects.toMatchObject({ code: "unknown_task" });
    await expect(client.status("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "unknown_job",
    });
  });
});
