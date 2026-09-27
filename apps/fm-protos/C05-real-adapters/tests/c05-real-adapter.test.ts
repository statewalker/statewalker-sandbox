import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckpointStore,
  JobModel,
  JobQueue,
  narrowStats,
  runCopyJob,
  StorageRegistry,
} from "@fm/core";
import type { FilesApi } from "@statewalker/webrun-files";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * C0.5 — everything above ran on MemFilesApi, which never denies permission,
 * never expires, and never fails a write halfway. This rung re-checks the core
 * behaviours that were ASSERTED but never OBSERVED, against a real filesystem.
 *
 * It runs before any UI, so a failure here is debugged through one unproven
 * layer rather than three.
 */

let root: string;
let api: FilesApi;

const seed = async (n: number) => {
  await mkdir(join(root, "src"), { recursive: true });
  for (let i = 0; i < n; i++) {
    await writeFile(join(root, "src", `f${String(i).padStart(3, "0")}.txt`), `body-${i}`);
  }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fm-"));
  api = new NodeFilesApi({ rootDir: root });
});

afterEach(async () => {
  await chmod(root, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("C0.5 · P1 conformance against a real filesystem", () => {
  it("reports the file variant with real size and mtime", async () => {
    await seed(1);
    const stats = narrowStats((await api.stats("/src/f000.txt"))!);
    expect(stats.kind).toBe("file");
    expect((stats as { size: number }).size).toBeGreaterThan(0);
  });

  it("narrows a directory to exactly the directory variant", async () => {
    await seed(1);
    expect(narrowStats((await api.stats("/src"))!)).toEqual({ kind: "directory" });
  });

  it("treats a real zero-byte file as size 0, not as a directory", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "empty.bin"), "");
    const stats = narrowStats((await api.stats("/src/empty.bin"))!);
    expect(stats).toEqual({ kind: "file", size: 0, lastModified: expect.any(Number) });
  });
});

describe("C0.5 · what mem could not tell us", () => {
  it("removes the partial target when a real write is interrupted", async () => {
    await seed(4);
    const target = new NodeFilesApi({ rootDir: root });
    const job = new JobModel("j");

    // A source that throws mid-stream: the real interruption, not a simulated one.
    const failing: FilesApi = Object.create(api as object, {
      read: {
        value: (path: string) =>
          (async function* () {
            yield new TextEncoder().encode("partial-");
            if (path.endsWith("f002.txt")) throw new Error("device disconnected");
            yield new TextEncoder().encode("rest");
          })(),
      },
    });

    await runCopyJob({
      operation: "copy",
      source: { uri: "node://a", api: failing },
      target: { uri: "node://a", api: target, path: "/dst" },
      roots: ["/src"],
      batchSize: 1,
      job,
    });

    expect(job.status).toBe("failed");
    // The half-written file must be gone from the real filesystem.
    expect(await target.exists("/dst/f002.txt")).toBe(false);
    expect(await target.exists("/dst/f001.txt")).toBe(true);
  });

  it("fails the job reportably when the OS refuses the target path", async () => {
    // ENOTDIR, not EACCES: this suite runs as root in CI, where chmod denies
    // nothing and a permission test would pass vacuously. Writing beneath a
    // regular file is refused by the kernel for every user, so the assertion
    // means the same thing everywhere.
    await seed(2);
    await writeFile(join(root, "blocker"), "not a directory");

    const job = new JobModel("j");
    await runCopyJob({
      operation: "copy",
      source: { uri: "node://a", api },
      target: { uri: "node://a", api, path: "/blocker/dst" },
      roots: ["/src"],
      batchSize: 2,
      job,
    });

    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/ENOTDIR|not a directory/i);
  });

  it.skipIf(process.getuid?.() === 0)("fails reportably on a permission denial", async () => {
    await seed(2);
    await mkdir(join(root, "locked"));
    await chmod(join(root, "locked"), 0o500); // r-x: no writes

    const job = new JobModel("j");
    await runCopyJob({
      operation: "copy",
      source: { uri: "node://a", api },
      target: { uri: "node://a", api, path: "/locked/dst" },
      roots: ["/src"],
      batchSize: 2,
      job,
    });

    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/EACCES|permission/i);
  });

  it("resumes a real interrupted copy without recopying finished entries", async () => {
    await seed(12);
    const checkpoints = new CheckpointStore(new NodeFilesApi({ rootDir: root }), "/jobs");

    const first = new JobModel("real-1");
    const run = runCopyJob({
      operation: "copy",
      source: { uri: "node://a", api },
      target: { uri: "node://a", api, path: "/dst" },
      roots: ["/src"],
      batchSize: 2,
      job: first,
      checkpoints,
    });
    await new Promise((r) => setTimeout(r, 1));
    first.cancel();
    await run;
    expect(first.completed).toBeLessThan(12);

    const written: string[] = [];
    const second = new JobModel("real-2");
    await runCopyJob({
      operation: "copy",
      source: { uri: "node://a", api },
      target: { uri: "node://a", api, path: "/dst" },
      roots: ["/src"],
      batchSize: 2,
      job: second,
      checkpoints,
      resumeFrom: "real-1",
      onWritten: (path) => written.push(path),
    });

    const all = [];
    for await (const entry of api.list("/dst", { recursive: true })) all.push(entry.path);
    expect(all.length).toBe(12);
    expect(new Set(written).size).toBe(written.length); // nothing written twice
    expect(written.length).toBe(12 - first.completed);
  });

  it("reports, rather than crashes, when a storage cannot be re-acquired on resume", async () => {
    const registry = new StorageRegistry(
      [
        { uri: "node://a", adapter: "node", options: {} },
        { uri: "node://gone", adapter: "node", options: { fail: true } },
      ],
      {
        node: (_uri, options) => {
          if (options.fail) throw new Error("permission revoked");
          return api;
        },
      },
      {
        async get() {
          return undefined;
        },
      },
    );
    const queue = new JobQueue(registry, { batchSize: 2 });
    await seed(4);

    const bad = queue.enqueue({
      operation: "copy",
      sourceUri: "node://a",
      targetUri: "node://gone",
      roots: ["/src"],
      targetPath: "/dst",
    });
    await bad.done;
    expect(bad.status).toBe("failed");
    expect(bad.error).toMatch(/permission revoked/);

    const good = queue.enqueue({
      operation: "copy",
      sourceUri: "node://a",
      targetUri: "node://a",
      roots: ["/src"],
      targetPath: "/dst",
    });
    await good.done;
    expect(good.status).toBe("done"); // the lane survived
  });

  it("serialises same-target jobs under real I/O latency", async () => {
    await seed(6);
    const registry = new StorageRegistry(
      [{ uri: "node://a", adapter: "node", options: {} }],
      { node: () => api },
      {
        async get() {
          return undefined;
        },
      },
    );
    const timeline: string[] = [];
    const queue = new JobQueue(registry, { batchSize: 2 });
    const enqueue = (label: string, targetPath: string) =>
      queue.enqueue({
        operation: "copy",
        sourceUri: "node://a",
        targetUri: "node://a",
        roots: ["/src"],
        targetPath,
        hooks: {
          onStart: () => timeline.push(`start:${label}`),
          onEnd: () => timeline.push(`end:${label}`),
        },
      });

    const one = enqueue("one", "/dst1");
    const two = enqueue("two", "/dst2");
    await Promise.all([one.done, two.done]);
    expect(timeline).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("performs a real move as copy-then-delete with no premature removal", async () => {
    await seed(5);
    const job = new JobModel("m");
    await runCopyJob({
      operation: "move",
      source: { uri: "node://a", api },
      target: { uri: "node://b", api, path: "/dst" }, // different URI: no native move
      roots: ["/src"],
      batchSize: 2,
      job,
    });
    expect(job.status).toBe("done");
    for (let i = 0; i < 5; i++) {
      expect(await api.exists(`/src/f00${i}.txt`)).toBe(false);
      expect(await api.exists(`/dst/f00${i}.txt`)).toBe(true);
    }
  });
});

describe("C0.5 · adapter parity", () => {
  it("declares the same capability surface as mem, so the registry needs no special case", async () => {
    const registry = new StorageRegistry(
      [{ uri: "node://a", adapter: "node", options: {} }],
      { node: () => api },
      {
        async get() {
          return undefined;
        },
      },
    );
    expect(registry.caps("node://a").stat).toEqual({ size: true, mtime: true });
    expect(registry.sortColumns("node://a")).toEqual(["name", "size", "date"]);
    // The hook exists and nothing implements it — true of every adapter,
    // including a real filesystem one.
    expect(registry.canWatch("node://a")).toBe(false);
  });

  it("enumerates a real tree in the same deterministic order on every run", async () => {
    await mkdir(join(root, "src/sub/deep"), { recursive: true });
    await writeFile(join(root, "src/zeta.txt"), "z");
    await writeFile(join(root, "src/alpha.txt"), "a");
    await writeFile(join(root, "src/sub/deep/x.txt"), "x");

    const orders: string[][] = [];
    for (const run of [0, 1]) {
      const seen: string[] = [];
      const job = new JobModel(`order-${run}`);
      await runCopyJob({
        operation: "copy",
        source: { uri: "node://a", api },
        target: { uri: "node://a", api, path: `/out${run}` },
        roots: ["/src"],
        batchSize: 1,
        job,
        onBatch: (batch) => seen.push(...batch),
      });
      orders.push(seen);
    }
    expect(orders[0]).toEqual(orders[1]);
    expect(orders[0]).toEqual(["/src/alpha.txt", "/src/sub/deep/x.txt", "/src/zeta.txt"]);
  });
});
