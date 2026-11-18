import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobManager, type JobManagerOptions, type ProcessJobManager } from "../src/index.ts";
import { collect, task, tempDir } from "./helpers.ts";

const TASKS = [
  task("image-generator", "image-generator.mjs", "image-generator.cleanup.mjs"),
  task("broken", "quick.mjs", "broken.cleanup.sh"),
  task("quick", "quick.mjs"),
  task("sleepy", "sleepy.sh"),
];

let dir: Awaited<ReturnType<typeof tempDir>>;
let bucket: string;
let manager: ProcessJobManager;

async function open(options: Partial<JobManagerOptions> = {}) {
  return createJobManager({ root: join(dir.path, "jobs"), tasks: TASKS, ...options });
}

async function run(task: string, params: unknown = null, input?: Uint8Array[]) {
  const id = await manager.start(task, params as never, input);
  await collect(manager.logs(id));
  return id;
}

beforeEach(async () => {
  dir = await tempDir();
  bucket = join(dir.path, "bucket");
  manager = await open();
});

afterEach(async () => {
  await manager.close();
  await dir.remove();
});

describe("cleanup", () => {
  it("runs the task's cleanup script with the job's messages, then forgets the job", async () => {
    const image = [new Uint8Array(200).fill(7)];
    const id = await run("image-generator", { bucket, sizes: [16, 32] }, image);
    expect((await readdir(join(bucket, id))).sort()).toEqual(["16.bin", "32.bin"]);

    expect(await manager.cleanup()).toEqual({ removed: [id], failed: [] });

    expect(existsSync(join(bucket, id))).toBe(false);
    await expect(manager.status(id)).rejects.toMatchObject({ code: "unknown_job" });
  });

  it("removes a finished job of a task without a cleanup script", async () => {
    const id = await run("quick");
    expect(await manager.cleanup()).toEqual({ removed: [id], failed: [] });
  });

  it("keeps jobs that are still running", async () => {
    const id = await manager.start("sleepy", null);
    for await (const m of manager.logs(id)) if ("message" in m) break;
    expect(await manager.cleanup()).toEqual({ removed: [], failed: [] });
    expect(await manager.status(id)).toBe("running");
  });

  it("only removes jobs that finished before the given stamp", async () => {
    const old = await run("quick");
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const recent = await run("quick");

    expect(await manager.cleanup(cutoff)).toEqual({ removed: [old], failed: [] });
    expect(await manager.status(recent)).toBe("done");
  });

  it("keeps a job whose cleanup script fails, and reports why", async () => {
    const id = await run("broken");
    const result = await manager.cleanup();
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([
      { id, error: expect.stringContaining("cannot reach the bucket") },
    ]);
    expect(await manager.status(id)).toBe("done");
  });

  it("removes old finished jobs periodically when retention is configured", async () => {
    await manager.close();
    manager = await open({ retention: { maxAgeMs: 100, intervalMs: 50 } });
    const id = await run("image-generator", { bucket, sizes: [8] }, [new Uint8Array(10)]);
    await expect
      .poll(() => manager.status(id).catch((e) => e.code), { timeout: 3000 })
      .toBe("unknown_job");
    expect(existsSync(join(bucket, id))).toBe(false);
  });
});
