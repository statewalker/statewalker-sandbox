import {
  CheckpointStore,
  DEFAULTS,
  JobModel,
  JobQueue,
  runCopyJob,
  StorageRegistry,
} from "@fm/core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";

/** C0 — the three decisions Phase B deliberately left open. */

const seeded = (n: number) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) files[`/src/f${String(i).padStart(3, "0")}.txt`] = `b${i}`;
  return new MemFilesApi({ initialFiles: files });
};

describe("C0 · batch size and parallelism", () => {
  it("defaults conservatively rather than to an unbounded fan-out", () => {
    expect(DEFAULTS.batchSize).toBe(8);
  });

  it("is declared per storage, because a remote backend is not OPFS", async () => {
    const instances: Record<string, MemFilesApi> = {
      "mem://a": seeded(20),
      "s3://b": new MemFilesApi(),
    };
    const registry = new StorageRegistry(
      [
        { uri: "mem://a", adapter: "mem", options: {} },
        { uri: "s3://b", adapter: "mem", options: {}, batchSize: 2 },
      ],
      { mem: (uri) => instances[uri] },
      {
        async get() {
          return undefined;
        },
      },
    );
    expect(registry.batchSize("mem://a")).toBe(DEFAULTS.batchSize);
    expect(registry.batchSize("s3://b")).toBe(2);

    const sizes: number[] = [];
    const queue = new JobQueue(registry, { onBatch: (b) => sizes.push(b.length) });
    const job = queue.enqueue({
      operation: "copy",
      sourceUri: "mem://a",
      targetUri: "s3://b",
      roots: ["/src"],
      targetPath: "/dst",
    });
    await job.done;
    // The TARGET's declaration governs: it is the side being written to.
    expect(sizes.every((n) => n <= 2)).toBe(true);
  });
});

describe("C0 · a cancelled copy reports, it does not clean up", () => {
  it("leaves already-copied entries in place", async () => {
    const source = seeded(30);
    const target = new MemFilesApi();
    const job = new JobModel("j");
    const run = runCopyJob({
      operation: "copy",
      source: { uri: "mem://a", api: source },
      target: { uri: "mem://b", api: target, path: "/dst" },
      roots: ["/src"],
      batchSize: 2,
      job,
    });
    await new Promise((r) => setTimeout(r, 0));
    job.cancel();
    await run;

    const copied = [];
    for await (const e of target.list("/dst", { recursive: true })) copied.push(e);
    expect(job.status).toBe("cancelled");
    expect(copied.length).toBe(job.completed);
    // Deleting them would destroy data the user can see and may want, and a
    // cancelled COPY has taken nothing away. The boundary is the report.
    expect(job.boundary()).toBe(`copied ${job.completed} of 30`);
  });
});

describe("C0 · checkpoint retention", () => {
  const store = () => new CheckpointStore(new MemFilesApi());

  const interrupt = async (checkpoints: CheckpointStore, id: string) => {
    const job = new JobModel(id);
    const run = runCopyJob({
      operation: "copy",
      source: { uri: "mem://a", api: seeded(20) },
      target: { uri: "mem://b", api: new MemFilesApi(), path: "/dst" },
      roots: ["/src"],
      batchSize: 2,
      job,
      checkpoints,
      // A skip so errors.json actually exists — discard must remove BOTH the
      // cursor and the error record, or a re-enqueued job inherits stale skips.
      shouldSkip: (path) => path.endsWith("f001.txt"),
    });
    await new Promise((r) => setTimeout(r, 0));
    job.cancel();
    await run;
    return job;
  };

  it("keeps an interrupted job's cursor until it is explicitly discarded", async () => {
    const checkpoints = store();
    await interrupt(checkpoints, "j1");
    expect(await checkpoints.load("j1")).toBeDefined();

    expect(await checkpoints.errors("j1")).not.toEqual([]);

    await checkpoints.discard("j1");
    expect(await checkpoints.load("j1")).toBeUndefined();
    expect(await checkpoints.errors("j1")).toEqual([]);
  });

  it("never expires a cursor on age alone", async () => {
    const checkpoints = store();
    await interrupt(checkpoints, "old");
    // A resumable job is a promise to the user; time does not revoke it. Only
    // an explicit discard or a successful completion removes a cursor.
    expect(await checkpoints.pruneCompleted()).toEqual([]);
    expect(await checkpoints.load("old")).toBeDefined();
  });

  it("prunes cursors whose job completed while the report was open", async () => {
    const checkpoints = store();
    await interrupt(checkpoints, "done-later");
    await checkpoints.clear("done-later");
    expect(await checkpoints.listInterrupted()).toEqual([]);
  });
});
