import {
  CheckpointStore,
  type Cursor,
  JobModel,
  JobQueue,
  runCopyJob,
  StorageRegistry,
} from "@fm/core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * C0 — the three open core decisions, and the two bugs the fake engine hid.
 *
 * RECONSTRUCTED, not recovered. C0 is the one rung with no archive: these five
 * cases are written from the record's prose and its mutation table (C0-M1, M2,
 * M3, M5, M6), which name the behaviour and the failure precisely enough to
 * re-derive. Each was confirmed to fail against the mutation it is aimed at.
 */

const seeded = (n: number, prefix = "/src") => {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) files[`${prefix}/f${i}.txt`] = `b${i}`;
  return new MemFilesApi({ initialFiles: files });
};

/** A completed job clears its cursor, so the record is captured as it is written. */
class RecordingFilesApi extends MemFilesApi {
  readonly written = new Map<string, string>();
  async write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of content as AsyncIterable<Uint8Array>) chunks.push(chunk);
    this.written.set(path, chunks.map((c) => new TextDecoder().decode(c)).join(""));
    return super.write(path, chunks);
  }
}

describe("C0 · batch size is declared per storage and governed by the target", () => {
  it("reads the batch size of the TARGET, not the source, and not a global", async () => {
    const instances: Record<string, MemFilesApi> = {
      "mem://fast": seeded(6),
      "mem://slow": new MemFilesApi(),
    };
    const registry = new StorageRegistry(
      [
        // The source declares 6 and the target declares 2. The target wins: it
        // is the side being written to, and a rate-limited remote is not OPFS.
        { uri: "mem://fast", adapter: "mem", options: {}, batchSize: 6 },
        { uri: "mem://slow", adapter: "mem", options: {}, batchSize: 2 },
      ],
      { mem: (uri) => instances[uri] },
      {
        async get() {
          return undefined;
        },
      },
    );
    expect(registry.batchSize("mem://slow")).toBe(2);
    // An unconfigured storage falls back to DEFAULTS.batchSize.
    expect(registry.batchSize("mem://unconfigured")).toBe(8);

    const store = new RecordingFilesApi();
    const queue = new JobQueue(registry, { checkpoints: new CheckpointStore(store) });
    const job = queue.enqueue({
      operation: "copy",
      sourceUri: "mem://fast",
      targetUri: "mem://slow",
      roots: ["/src"],
      targetPath: "/dst",
    });
    await job.done;
    expect(job.status).toBe("done");

    // 6 entries at the target's batch size of 2 is three batches, so the last
    // cursor written records batch index 2. At the source's 6 it would be 0.
    const cursor = JSON.parse(store.written.get(`/jobs/${job.id}/cursor.json`) as string) as Cursor;
    expect(cursor.spec.batchSize).toBe(2);
    expect(cursor.lastCompletedBatch).toBe(2);
  });
});

describe("C0 · checkpoint retention has no age rule", () => {
  let checkpoints: CheckpointStore;

  beforeEach(() => {
    checkpoints = new CheckpointStore(new MemFilesApi());
  });

  const interrupt = (jobId: string, remaining: number) =>
    checkpoints.save(jobId, {
      lastCompletedBatch: 0,
      cursorPath: "/src/f0.txt",
      remaining,
      spec: {
        operation: "copy",
        source: { uri: "mem://a" },
        target: { uri: "mem://b", path: "/dst" },
        roots: ["/src"],
        batchSize: 2,
      },
    });

  it("discard removes the cursor AND errors.json, or a re-enqueue inherits stale skips", async () => {
    await interrupt("j-discard", 4);
    await checkpoints.recordErrors("j-discard", [{ path: "/src/f1.txt", reason: "skipped" }]);
    // The strengthened form: the job must actually HAVE produced errors, or the
    // assertion passes vacuously — which is how C0-M2 survived its first pass.
    expect(await checkpoints.errors("j-discard")).toHaveLength(1);

    await checkpoints.discard("j-discard");
    expect(await checkpoints.load("j-discard")).toBeUndefined();
    expect(await checkpoints.errors("j-discard")).toEqual([]);
  });

  it("pruneCompleted removes only the records whose job actually finished", async () => {
    await interrupt("j-finished", 0);
    await interrupt("j-abandoned", 97);

    expect(await checkpoints.pruneCompleted()).toEqual(["j-finished"]);
    expect(await checkpoints.load("j-finished")).toBeUndefined();
    // A resumable job is a promise to the user and time does not revoke it: the
    // case an age rule would fire on is a long-abandoned large transfer, which
    // is exactly the case worth keeping.
    expect(await checkpoints.load("j-abandoned")).toBeDefined();
  });
});

describe("C0 · the two bugs deleting the fake engine exposed", () => {
  it("reports the TARGET path from onWritten, on the move branch as well as the copy branch", async () => {
    // C0-M5 first survived because the mutation landed in the same-storage MOVE
    // branch, which no copy test reaches. Both sides are asserted here.
    for (const operation of ["copy", "move"] as const) {
      const api = new MemFilesApi({ initialFiles: { "/src/a.txt": "a" } });
      const seen: string[] = [];
      const job = new JobModel(`written-${operation}`);
      await runCopyJob({
        operation,
        source: { uri: "mem://same", api },
        target: { uri: "mem://same", api, path: "/dst" },
        roots: ["/src"],
        batchSize: 4,
        job,
        onWritten: (path) => seen.push(path),
      });
      expect(job.status, operation).toBe("done");
      expect(seen, `${operation} must report the target path`).toEqual(["/dst/a.txt"]);
    }
  });

  it("records an error raised in the FINAL batch, not only in an earlier one", async () => {
    // Errors ride the same barrier as the cursor. Written only after the loop, a
    // cancellation returning from inside it loses the record — and the resumed
    // job asks the user again about entries they already answered for.
    const checkpoints = new CheckpointStore(new MemFilesApi());
    const job = new JobModel("j-final-skip");
    await runCopyJob({
      operation: "copy",
      source: { uri: "mem://a", api: seeded(4) },
      target: { uri: "mem://b", api: new MemFilesApi(), path: "/dst" },
      roots: ["/src"],
      batchSize: 2,
      job,
      checkpoints,
      shouldSkip: (p) => p.endsWith("f3.txt"), // the last entry of the last batch
    });
    expect(job.status).toBe("done");
    expect(await checkpoints.errors("j-final-skip")).toEqual([
      { path: "/src/f3.txt", reason: "skipped" },
    ]);
  });
});
