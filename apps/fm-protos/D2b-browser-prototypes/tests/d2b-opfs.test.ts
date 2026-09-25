import { CheckpointStore, JobModel, narrowStats, runCopyJob } from "@fm/core";
import type { FilesApi } from "@statewalker/webrun-files";
import { getOPFSFilesApi } from "@statewalker/webrun-files-browser";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * D2b — closes the C0.5 gap: OPFS is browser-only, so mem and Node could not
 * answer for it. Same assertions, real origin-private filesystem.
 */

let api: FilesApi;
let root: string;

const seed = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await api.write(`${root}/src/f${String(i).padStart(3, "0")}.txt`, [
      new TextEncoder().encode(`body-${i}`),
    ]);
  }
};

beforeEach(async () => {
  api = await getOPFSFilesApi();
  root = `/run-${Math.random().toString(36).slice(2)}`;
  await api.mkdir(root);
});

describe("D2b · OPFS conformance", () => {
  it("reports the file variant with a real size and mtime", async () => {
    await seed(1);
    const stats = narrowStats((await api.stats(`${root}/src/f000.txt`))!);
    expect(stats.kind).toBe("file");
    expect((stats as { size: number }).size).toBeGreaterThan(0);
  });

  it("narrows a directory to exactly the directory variant", async () => {
    await seed(1);
    expect(narrowStats((await api.stats(`${root}/src`))!)).toEqual({ kind: "directory" });
  });

  it("treats a zero-byte file as size 0, not as a directory", async () => {
    await api.write(`${root}/empty.bin`, [new Uint8Array(0)]);
    const stats = narrowStats((await api.stats(`${root}/empty.bin`))!);
    expect(stats).toEqual({ kind: "file", size: 0, lastModified: expect.any(Number) });
  });

  it("enumerates in the same deterministic order on every run", async () => {
    await seed(6);
    const orders: string[][] = [];
    for (const run of [0, 1]) {
      const seen: string[] = [];
      const job = new JobModel(`order-${run}`);
      await runCopyJob({
        operation: "copy",
        source: { uri: "opfs://a", api },
        target: { uri: "opfs://a", api, path: `${root}/out${run}` },
        roots: [`${root}/src`],
        batchSize: 2,
        job,
        onBatch: (batch) => seen.push(...batch),
      });
      orders.push(seen);
    }
    expect(orders[0]).toEqual(orders[1]);
  });
});

describe("D2b · the engine against OPFS", () => {
  it("copies a tree and cancels on a clean batch boundary", async () => {
    await seed(20);
    const job = new JobModel("j");
    const run = runCopyJob({
      operation: "copy",
      source: { uri: "opfs://a", api },
      target: { uri: "opfs://a", api, path: `${root}/dst` },
      roots: [`${root}/src`],
      batchSize: 4,
      job,
    });
    await new Promise((r) => setTimeout(r, 0));
    job.cancel();
    await run;

    expect(job.status).toBe("cancelled");
    expect(job.completed % 4).toBe(0);
    expect(job.completed).toBeLessThan(20);
  });

  it("resumes from a checkpoint stored in OPFS itself", async () => {
    await seed(12);
    const checkpoints = new CheckpointStore(api, `${root}/jobs`);

    const first = new JobModel("opfs-1");
    const run = runCopyJob({
      operation: "copy",
      source: { uri: "opfs://a", api },
      target: { uri: "opfs://a", api, path: `${root}/dst` },
      roots: [`${root}/src`],
      batchSize: 2,
      job: first,
      checkpoints,
    });
    await new Promise((r) => setTimeout(r, 0));
    first.cancel();
    await run;
    expect(first.completed).toBeLessThan(12);

    const written: string[] = [];
    await runCopyJob({
      operation: "copy",
      source: { uri: "opfs://a", api },
      target: { uri: "opfs://a", api, path: `${root}/dst` },
      roots: [`${root}/src`],
      batchSize: 2,
      job: new JobModel("opfs-2"),
      checkpoints,
      resumeFrom: "opfs-1",
      onWritten: (path) => written.push(path),
    });

    const all: string[] = [];
    for await (const entry of api.list(`${root}/dst`, { recursive: true })) all.push(entry.path);
    expect(all.length).toBe(12);
    expect(new Set(written).size).toBe(written.length);
  });

  it("removes a partial target when a write is interrupted", async () => {
    await seed(4);
    const failing: FilesApi = Object.create(api as object, {
      read: {
        value: (path: string) =>
          (async function* () {
            yield new TextEncoder().encode("partial-");
            if (path.endsWith("f002.txt")) throw new Error("stream aborted");
            yield new TextEncoder().encode("rest");
          })(),
      },
    });
    const job = new JobModel("j");
    await runCopyJob({
      operation: "copy",
      source: { uri: "opfs://a", api: failing },
      target: { uri: "opfs://a", api, path: `${root}/dst` },
      roots: [`${root}/src`],
      batchSize: 1,
      job,
    });

    expect(job.status).toBe("failed");
    expect(await api.exists(`${root}/dst/f002.txt`)).toBe(false);
    expect(await api.exists(`${root}/dst/f001.txt`)).toBe(true);
  });
});
