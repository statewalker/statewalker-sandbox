import { JobQueue, StorageRegistry } from "@fm/core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/** P6 — serialise mutating jobs per target storageURI; jobs outlive panels. */

const seeded = (n: number) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) files[`/src/f${i}.txt`] = `b${i}`;
  return new MemFilesApi({ initialFiles: files });
};

describe("P6 · job queue", () => {
  let registry: StorageRegistry;
  let queue: JobQueue;
  let timeline: string[];

  beforeEach(() => {
    const instances: Record<string, MemFilesApi> = {
      "mem://a": seeded(8),
      "mem://b": new MemFilesApi(),
      "mem://c": new MemFilesApi(),
    };
    registry = new StorageRegistry(
      ["mem://a", "mem://b", "mem://c"].map((uri) => ({ uri, adapter: "mem", options: {} })),
      { mem: (uri) => instances[uri] },
      {
        async get() {
          return undefined;
        },
      },
    );
    timeline = [];
    queue = new JobQueue(registry, { batchSize: 2 });
  });

  const copy = (label: string, targetUri: string) =>
    queue.enqueue({
      operation: "copy",
      sourceUri: "mem://a",
      targetUri,
      roots: ["/src"],
      targetPath: `/${label}`,
      hooks: {
        onStart: () => timeline.push(`start:${label}`),
        onEnd: () => timeline.push(`end:${label}`),
      },
    });

  it("serialises mutating jobs that target the same storage", async () => {
    const one = copy("one", "mem://b");
    const two = copy("two", "mem://b");
    await Promise.all([one.done, two.done]);
    expect(timeline).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("runs jobs on different storages in parallel", async () => {
    const one = copy("one", "mem://b");
    const two = copy("two", "mem://c");
    await Promise.all([one.done, two.done]);
    // both started before either ended
    expect(timeline.slice(0, 2).sort()).toEqual(["start:one", "start:two"]);
  });

  it("exposes a global activity surface of live jobs", async () => {
    const one = copy("one", "mem://b");
    const two = copy("two", "mem://c");
    expect(
      queue
        .active()
        .map((j) => j.id)
        .sort(),
    ).toEqual([one.id, two.id].sort());
    await Promise.all([one.done, two.done]);
    expect(queue.active()).toEqual([]);
  });

  it("cancels each job independently", async () => {
    const one = copy("one", "mem://b");
    const two = copy("two", "mem://c");
    one.cancel();
    await Promise.all([one.done, two.done]);
    expect(one.status).toBe("cancelled");
    expect(two.status).toBe("done");
  });

  it("never starts a queued job that was cancelled while waiting", async () => {
    const one = copy("one", "mem://b");
    const two = copy("two", "mem://b");
    two.cancel();
    await Promise.all([one.done, two.done]);
    expect(timeline).toEqual(["start:one", "end:one"]);
    expect(two.status).toBe("cancelled");
    expect(two.completed).toBe(0);
  });

  describe("jobs are independent of panels", () => {
    it("keeps BOTH endpoints alive after the panels that started it are removed", async () => {
      await registry.acquire("mem://a", "panel:p1"); // source panel
      await registry.acquire("mem://b", "panel:p2"); // target panel
      const job = copy("one", "mem://b");

      // Both panels close in the same tick the copy was requested. The job's
      // refcounts must already be pinned, or an instance is disposed under it.
      registry.release("mem://a", "panel:p1");
      registry.release("mem://b", "panel:p2");
      expect(registry.isLive("mem://a")).toBe(true);
      expect(registry.isLive("mem://b")).toBe(true);

      await job.done;
      expect(job.status).toBe("done");
      expect(registry.isLive("mem://b")).toBe(false); // released when the job ended
    });

    it("releases both endpoints exactly once when the job ends", async () => {
      const job = copy("one", "mem://b");
      await job.done;
      expect(registry.isLive("mem://a")).toBe(false);
      expect(registry.isLive("mem://b")).toBe(false);
    });

    it("reports a storage that cannot be acquired without killing the queue", async () => {
      const bad = queue.enqueue({
        operation: "copy",
        sourceUri: "mem://a",
        targetUri: "mem://missing",
        roots: ["/src"],
        targetPath: "/x",
      });
      await bad.done;
      expect(bad.status).toBe("failed");
      // The reason must name the storage, not a generic end-of-job message.
      expect(bad.error).toMatch(/mem:\/\/missing/);

      const good = copy("after", "mem://b");
      await good.done;
      expect(good.status).toBe("done");
    });
  });
});
