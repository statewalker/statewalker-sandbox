import { CheckpointStore, JobModel, type JobSpec, runCopyJob } from "@fm/core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/** P4 — batch cursor, errors.json, report-and-re-enqueue. */

function seeded(n: number): MemFilesApi {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) files[`/src/f${String(i).padStart(4, "0")}.txt`] = `body-${i}`;
  return new MemFilesApi({ initialFiles: files });
}

/** Counts every byte written, so O(1)-per-batch is measured, not asserted. */
class CountingFilesApi extends MemFilesApi {
  bytes = 0;
  writes = 0;
  async write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    for await (const c of content as AsyncIterable<Uint8Array>) chunks.push(c);
    this.writes++;
    this.bytes += chunks.reduce((n, c) => n + c.length, 0);
    return super.write(path, chunks);
  }
}

describe("P4 · checkpoint and resume", () => {
  let source: MemFilesApi;
  let target: MemFilesApi;
  let store: CountingFilesApi;
  let checkpoints: CheckpointStore;

  const spec = (job: JobModel, over: Partial<JobSpec> = {}): JobSpec => ({
    operation: "copy",
    source: { uri: "mem://a", api: source },
    target: { uri: "mem://b", api: target, path: "/dst" },
    roots: ["/src"],
    batchSize: 4,
    job,
    checkpoints,
    ...over,
  });

  beforeEach(() => {
    source = seeded(20);
    target = new MemFilesApi();
    store = new CountingFilesApi();
    // The checkpoint lives in a host-provided FilesApi, separate from any storage.
    checkpoints = new CheckpointStore(store);
  });

  it("writes the cursor after EVERY batch, not on a flush interval", async () => {
    const job = new JobModel("j1");
    await runCopyJob(spec(job));
    expect(store.writes).toBe(5); // 20 entries / batch 4 — one cursor write per batch
    const cursor = await checkpoints.load("j1");
    expect(cursor).toBeUndefined(); // completed jobs leave nothing behind
  });

  it("cursor cost is flat per batch, not quadratic in entries", async () => {
    const job1 = new JobModel("small");
    await runCopyJob(spec(job1, { batchSize: 1, source: { uri: "mem://a", api: seeded(10) } }));
    const tenBatches = store.bytes;

    store.bytes = 0;
    const job2 = new JobModel("big");
    await runCopyJob(spec(job2, { batchSize: 1, source: { uri: "mem://a", api: seeded(20) } }));
    const twentyBatches = store.bytes;

    // A growing completed-list is O(n²); a cursor is O(n) with a bounded record.
    expect(twentyBatches).toBeLessThan(tenBatches * 3);
  });

  it("holds lastCompletedBatch, cursorPath and the spec", async () => {
    const job = new JobModel("j2");
    const run = runCopyJob(spec(job));
    await new Promise((r) => setTimeout(r, 0));
    job.cancel();
    await run;

    const cursor = (await checkpoints.load("j2"))!;
    expect(cursor.lastCompletedBatch).toBeGreaterThanOrEqual(0);
    expect(cursor.cursorPath).toMatch(/^\/src\/f\d{4}\.txt$/);
    expect(cursor.spec.target.path).toBe("/dst");
    expect(cursor.spec.operation).toBe("copy");
  });

  it("records skipped and failed entries in errors.json, which a cursor cannot express", async () => {
    const job = new JobModel("j3");
    await runCopyJob(spec(job, { batchSize: 2, shouldSkip: (p) => p.endsWith("0003.txt") }));
    const errors = await checkpoints.errors("j3");
    expect(errors).toEqual([{ path: "/src/f0003.txt", reason: "skipped" }]);
    expect(await target.exists("/dst/f0003.txt")).toBe(false);
    expect(job.status).toBe("done");
  });

  describe("resume", () => {
    it("re-enqueues and copies every remaining entry exactly once", async () => {
      const first = new JobModel("j4");
      const run = runCopyJob(spec(first));
      await new Promise((r) => setTimeout(r, 0));
      first.cancel();
      await run;
      expect(first.completed).toBeLessThan(20);

      const copiedBefore = [];
      for await (const e of target.list("/dst", { recursive: true })) copiedBefore.push(e.path);

      const writes: string[] = [];
      const second = new JobModel("j4-resume");
      await runCopyJob(
        spec(second, {
          resumeFrom: "j4",
          onEntry: (p, phase) => phase === "wrote" && writes.push(p),
        }),
      );

      // nothing already done is copied a second time
      for (const path of copiedBefore) {
        expect(writes).not.toContain(path.replace("/dst", "/src"));
      }
      const all = [];
      for await (const e of target.list("/dst", { recursive: true })) all.push(e.path);
      expect(all.length).toBe(20);
      expect(new Set(all).size).toBe(20);
    });

    it("keeps the cursor when cancellation lands during the FINAL batch", async () => {
      // The in-loop abort check covers early cancellation; this is the other
      // path — the loop runs to completion and only then sees the abort. A
      // cursor cleared here would make the job unresumable.
      const job = new JobModel("j-last");
      await runCopyJob(
        spec(job, {
          source: { uri: "mem://a", api: seeded(8) },
          onEntry: (path) => {
            if (path.endsWith("f0007.txt")) job.cancel();
          },
        }),
      );
      expect(job.status).toBe("cancelled");
      expect(await checkpoints.load("j-last")).toBeDefined();
    });

    it("is reproducible: the same interruption yields the same order twice", async () => {
      const order: string[][] = [];
      for (const run of [0, 1]) {
        target = new MemFilesApi();
        const job = new JobModel(`rep-${run}`);
        const seen: string[] = [];
        await runCopyJob(spec(job, { onBatch: (b) => seen.push(...b) }));
        order.push(seen);
      }
      expect(order[0]).toEqual(order[1]);
    });

    it("reports interrupted jobs at startup", async () => {
      const job = new JobModel("j5");
      const run = runCopyJob(spec(job));
      await new Promise((r) => setTimeout(r, 0));
      job.cancel();
      await run;

      const interrupted = await checkpoints.listInterrupted();
      expect(interrupted.map((r) => r.jobId)).toEqual(["j5"]);
      expect(interrupted[0].remaining).toBe(20 - job.completed);
    });

    it("treats a storage that cannot be re-acquired as reportable, not a crash", async () => {
      const job = new JobModel("j6");
      const run = runCopyJob(spec(job));
      await new Promise((r) => setTimeout(r, 0));
      job.cancel();
      await run;

      const resumed = new JobModel("j6-resume");
      await runCopyJob(
        spec(resumed, {
          resumeFrom: "j6",
          source: {
            uri: "mem://a",
            get api(): never {
              throw new Error("auth expired");
            },
          } as never,
        }),
      );
      expect(resumed.status).toBe("failed");
      expect(resumed.error).toMatch(/auth expired/);
      expect(await checkpoints.load("j6")).toBeDefined(); // cursor survives a failed resume
    });
  });
});
