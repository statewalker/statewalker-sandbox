import { JobModel, type JobSpec, runCopyJob } from "@fm/core";
import type { FilesApi, ListOptions } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/** P3 — walk, deterministic order, batches, cancel. The highest-risk rung. */

function seeded(n: number, prefix = "/src"): MemFilesApi {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) files[`${prefix}/f${String(i).padStart(4, "0")}.txt`] = `body-${i}`;
  return new MemFilesApi({ initialFiles: files });
}

/** Records call order and can be told to fail or stall on a given path. */
class SpyFilesApi implements FilesApi {
  readonly writes: string[] = [];
  readonly removed: string[] = [];
  nativeCopies = 0;
  nativeMoves = 0;
  failOn?: string;
  constructor(private readonly inner: MemFilesApi) {}
  read(p: string, o?: never) {
    return this.inner.read(p, o);
  }
  async write(p: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of content as AsyncIterable<Uint8Array>) {
      if (this.failOn === p) throw new Error(`write failed: ${p}`);
      chunks.push(chunk);
    }
    this.writes.push(p);
    return this.inner.write(p, chunks);
  }
  mkdir(p: string) {
    return this.inner.mkdir(p);
  }
  list(p: string, o?: ListOptions) {
    return this.inner.list(p, o);
  }
  stats(p: string) {
    return this.inner.stats(p);
  }
  exists(p: string) {
    return this.inner.exists(p);
  }
  async remove(p: string) {
    this.removed.push(p);
    return this.inner.remove(p);
  }
  async move(s: string, t: string) {
    this.nativeMoves++;
    return this.inner.move(s, t);
  }
  async copy(s: string, t: string) {
    this.nativeCopies++;
    return this.inner.copy(s, t);
  }
}

describe("P3 · job engine", () => {
  let source: MemFilesApi;
  let target: SpyFilesApi;
  let job: JobModel;

  const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
    operation: "copy",
    source: { uri: "mem://a", api: source },
    target: { uri: "mem://b", api: target, path: "/dst" },
    roots: ["/src"],
    batchSize: 4,
    job,
    ...over,
  });

  beforeEach(() => {
    source = seeded(10);
    target = new SpyFilesApi(new MemFilesApi());
    job = new JobModel("j1");
  });

  describe("walks and transfers file by file", () => {
    it("never delegates to the adapter's recursive copy()", async () => {
      await runCopyJob(spec());
      expect(target.nativeCopies).toBe(0);
      expect(target.writes.length).toBe(10);
      expect(job.completed).toBe(10);
      expect(job.status).toBe("done");
    });

    it("uses native move() when source and target are the same storageURI", async () => {
      const same = new SpyFilesApi(seeded(3));
      await runCopyJob(
        spec({
          operation: "move",
          source: { uri: "mem://same", api: same },
          target: { uri: "mem://same", api: same, path: "/dst" },
        }),
      );
      expect(same.nativeMoves).toBe(3);
      expect(same.writes.length).toBe(0); // no read/write round trip
    });

    it("enumerates in deterministic sorted order, not list() order", async () => {
      const shuffled = new MemFilesApi({
        initialFiles: { "/src/z.txt": "z", "/src/a.txt": "a", "/src/m.txt": "m" },
      });
      await runCopyJob(spec({ source: { uri: "mem://a", api: shuffled } }));
      expect(target.writes).toEqual(["/dst/a.txt", "/dst/m.txt", "/dst/z.txt"]);
    });

    it("walks whole directory trees, recreating structure", async () => {
      const tree = new MemFilesApi({
        initialFiles: {
          "/src/one.txt": "1",
          "/src/sub/two.txt": "2",
          "/src/sub/deep/three.txt": "3",
        },
      });
      await runCopyJob(spec({ source: { uri: "mem://a", api: tree } }));
      expect(target.writes).toEqual([
        "/dst/one.txt",
        "/dst/sub/deep/three.txt",
        "/dst/sub/two.txt",
      ]);
    });
  });

  describe("batching", () => {
    it("processes files in parallel batches of the configured size", async () => {
      const observed: number[] = [];
      await runCopyJob(spec({ onBatch: (b) => observed.push(b.length) }));
      expect(observed).toEqual([4, 4, 2]);
    });

    it("reports progress at batch granularity, not per job", async () => {
      const seen: number[] = [];
      job.onUpdate(() => seen.push(job.completed));
      await runCopyJob(spec());
      expect(seen.filter((n, i, a) => n !== a[i - 1]).length).toBeGreaterThan(1);
    });
  });

  describe("cancellation", () => {
    it("stops within one batch boundary", async () => {
      const big = seeded(100);
      const run = runCopyJob(spec({ source: { uri: "mem://a", api: big }, batchSize: 4 }));
      await new Promise((r) => setTimeout(r, 0));
      job.cancel();
      await run;
      expect(job.status).toBe("cancelled");
      expect(job.completed).toBeLessThan(100);
      expect(job.completed % 4).toBe(0); // a clean batch boundary
    });

    it("leaves no partial file behind when a write is interrupted", async () => {
      target.failOn = "/dst/f0002.txt";
      await runCopyJob(spec({ batchSize: 1 }));
      expect(job.status).toBe("failed");
      expect(target.removed).toContain("/dst/f0002.txt"); // target removed on exception
    });
  });

  describe("move semantics", () => {
    it("is per-entry copy-then-delete, never a trailing delete pass", async () => {
      const src = new SpyFilesApi(seeded(6));
      const order: string[] = [];
      await runCopyJob(
        spec({
          operation: "move",
          source: { uri: "mem://a", api: src },
          onEntry: (path, phase) => order.push(`${phase}:${path}`),
        }),
      );
      // Parallel batches interleave, so the invariant is PER ENTRY, not global
      // pairing: each entry's removal follows its own write, and every write
      // has a removal. A trailing delete pass would put all removals last.
      expect(order.filter((o) => o.startsWith("removed:")).length).toBe(6);
      for (const path of new Set(order.map((o) => o.split(":")[1]))) {
        expect(order.indexOf(`wrote:${path}`)).toBeLessThan(order.indexOf(`removed:${path}`));
      }
      const lastWrite = order.map((o) => o.startsWith("wrote:")).lastIndexOf(true);
      const firstRemove = order.map((o) => o.startsWith("removed:")).indexOf(true);
      expect(firstRemove).toBeLessThan(lastWrite); // interleaved, not two passes
    });

    it("reports a precise boundary when cancelled, and the source keeps the rest", async () => {
      const src = new SpyFilesApi(seeded(40));
      const run = runCopyJob(
        spec({
          operation: "move",
          source: { uri: "mem://a", api: src },
          batchSize: 2,
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      job.cancel();
      await run;
      expect(job.status).toBe("cancelled");
      expect(src.removed.length).toBe(job.completed);
      const remaining = [];
      for await (const e of src.list("/src", { recursive: true })) remaining.push(e);
      expect(remaining.length).toBe(40 - job.completed);
      expect(job.boundary()).toBe(`moved ${job.completed} of 40, source retains the rest`);
    });

    it("never removes a source entry before its target write completed", async () => {
      const src = new SpyFilesApi(seeded(5));
      target.failOn = "/dst/f0003.txt";
      await runCopyJob(
        spec({ operation: "move", source: { uri: "mem://a", api: src }, batchSize: 1 }),
      );
      expect(src.removed).not.toContain("/src/f0003.txt");
    });
  });

  it("releases the event loop so the UI is not frozen", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    await runCopyJob(spec({ source: { uri: "mem://a", api: seeded(60) }, batchSize: 4 }));
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});
