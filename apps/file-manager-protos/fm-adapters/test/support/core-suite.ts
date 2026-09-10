/**
 * C0.5 — the P2–P6 core suites, ported to run against ANY adapter.
 *
 * ONE FILE, THREE ADAPTERS, SAME SOURCE. `mem` is the control: every assertion
 * here has to hold on `MemFilesApi` too, or the port quietly rewrote the
 * specification instead of moving it. `opfs` and `node` are the two non-mem
 * adapters C0.5 is done when.
 *
 * EVERY ASSERTION IS THE ADOPTED ONE unless a comment says otherwise and says
 * why. Two of them could not be carried across unchanged, and both are recorded
 * in `ADAPTERS.md` with the mem-specific accident that made the original true:
 * they are TIGHTENED here (they pin a window the adopted form asserted one point
 * of, plus a fact the adopted form derived rather than checked), never relaxed.
 *
 * P5's ninth case — the `readdirSync("src/core")` grep — is deliberately not
 * here. It is a boundary check over source text, not over a storage, and it
 * belongs in the node project with the other greps.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../../fm-core/src/checkpoints.js";
import { type ConflictResolution, type JobSpec, runCopyJob } from "../../../fm-core/src/copy-job.js";
import { JobModel } from "../../../fm-core/src/job-model.js";
import { JobQueue } from "../../../fm-core/src/job-queue.js";
import {
  type AdapterFactory,
  type StorageConfig,
  StorageRegistry,
} from "../../../fm-core/src/storage-registry.js";
import { providerSecrets } from "../../src/secrets.js";
import {
  type AdapterFixture,
  CountingFiles,
  listPaths,
  readText,
  seed,
  SpyFiles,
  type StorageFixture,
  writeText,
} from "./adapter-fixture.js";

export interface SuiteOptions {
  /** Fresh fixture per test. */
  readonly makeFixture: () => AdapterFixture;
  /** The `AdapterFactory` the registry uses for this adapter's storages. */
  readonly factory: AdapterFactory;
}

/**
 * Cancels `job` as its `nth` batch STARTS, so batches 0…nth-2 have completed and
 * checkpointed.
 *
 * THIS REPLACES `await new Promise((r) => setTimeout(r, 0))`, which six adopted
 * cases use to mean "the job is now in progress". On `MemFilesApi` that is exact:
 * every operation settles on the microtask queue, so a batch begun in a turn
 * always finishes in that turn, and the engine's own `yieldControl` macrotask is
 * queued after the test's. On a real adapter it is a guess, and it loses —
 * `enumerate()` alone takes several macrotasks over 20 real files, so the
 * cancellation frequently lands BEFORE the first batch, in a state none of those
 * six cases is about. Measured: 2 of 3 consecutive runs on `NodeFilesApi` failed,
 * in a different pair of cases each time.
 *
 * A flaky test is not a weak test, it is a test that cannot be relied on to fail.
 * The fix is to stop approximating the precondition and to establish it: `onBatch`
 * fires at the start of each batch, so its second call is proof that the first
 * batch finished and its cursor was written.
 */
function cancelOnBatch(job: JobModel, nth: number): (batch: string[]) => void {
  let seen = 0;
  return () => {
    if (++seen === nth) job.cancel();
  };
}

export function defineCoreSuite({ makeFixture, factory }: SuiteOptions): void {
  const caps = makeFixture().caps;

  describe(`C0.5 · core suites on ${caps.label}`, () => {
    let fixture: AdapterFixture;

    beforeEach(async () => {
      fixture = makeFixture();
      return async () => {
        await fixture.cleanup();
      };
    });

    /**
     * A registry over the fixture's storages, with construction and
     * root-resolution both counted. `constructions` stands in for the adopted
     * suite's homonym; `resolutions` is what it called `auths`, and on a real
     * adapter it is the number of times the platform was asked for the root —
     * which is what "authenticates once" actually means here.
     */
    function registryOver(storages: StorageFixture[], extra: StorageConfig[] = []) {
      const constructions: Record<string, number> = {};
      const resolutions: Record<string, number> = {};
      const configs: StorageConfig[] = [
        ...storages.map((s) => ({ uri: s.uri, adapter: "real", options: s.configOptions })),
        ...extra,
      ];
      const counted: AdapterFactory = (uri, options) => {
        constructions[uri] = (constructions[uri] ?? 0) + 1;
        return factory(uri, options);
      };
      const secrets = providerSecrets(
        Object.fromEntries(
          storages.map((s) => [
            s.secretKey,
            async () => {
              resolutions[s.uri] = (resolutions[s.uri] ?? 0) + 1;
              return s.rootSecret();
            },
          ]),
        ),
      );
      return {
        registry: new StorageRegistry(configs, { real: counted }, secrets),
        constructions,
        resolutions,
        configs,
      };
    }

    // ---------------------------------------------------------------- P2 ----

    describe("P2 · storage registry", () => {
      it("constructs at most one instance per storageURI", async () => {
        const left = await fixture.storage("left");
        const { registry, constructions } = registryOver([left]);
        const a = await registry.acquire(left.uri, "panel:p1");
        const b = await registry.acquire(left.uri, "panel:p2");
        const c = await registry.acquire(left.uri, "job:j1");
        expect(a.api).toBe(b.api);
        expect(b.api).toBe(c.api);
        expect(constructions[left.uri]).toBe(1);
      });

      it("resolves a storage root once no matter how many panels use it", async () => {
        const left = await fixture.storage("left");
        const { registry, resolutions } = registryOver([left]);
        for (const holder of ["p1", "p2", "p3", "p4"]) {
          await registry.acquire(left.uri, `panel:${holder}`);
        }
        expect(resolutions[left.uri]).toBe(1);
      });

      it("disposes only when the last holder releases", async () => {
        const left = await fixture.storage("left");
        const { registry } = registryOver([left]);
        await registry.acquire(left.uri, "panel:p1");
        await registry.acquire(left.uri, "panel:p2");
        await registry.acquire(left.uri, "job:j1");

        registry.release(left.uri, "panel:p1");
        registry.release(left.uri, "panel:p2");
        expect(registry.isLive(left.uri)).toBe(true); // the job still holds it

        registry.release(left.uri, "job:j1");
        expect(registry.isLive(left.uri)).toBe(false);
      });

      it("re-acquiring after full release constructs a fresh instance", async () => {
        const left = await fixture.storage("left");
        const { registry, constructions } = registryOver([left]);
        await registry.acquire(left.uri, "panel:p1");
        registry.release(left.uri, "panel:p1");
        await registry.acquire(left.uri, "panel:p2");
        expect(constructions[left.uri]).toBe(2);
      });

      it("release by an unknown holder is a no-op, not a decrement", async () => {
        const left = await fixture.storage("left");
        const { registry } = registryOver([left]);
        await registry.acquire(left.uri, "panel:p1");
        registry.release(left.uri, "panel:nobody");
        registry.release(left.uri, "panel:nobody");
        expect(registry.isLive(left.uri)).toBe(true);
      });

      describe("secrets", () => {
        it("resolves root references by key and keeps them out of the config", async () => {
          const left = await fixture.storage("left");
          const { registry, configs, resolutions } = registryOver([left]);
          // Captured before, compared after: the adopted form looked for one
          // known string, which a `FileSystemDirectoryHandle` does not have. The
          // property it was checking is that NOTHING resolved is written back,
          // and comparing the whole config to itself checks all of it.
          const before = JSON.stringify(configs);
          await registry.acquire(left.uri, "panel:p1");
          expect(resolutions[left.uri]).toBe(1);
          expect(JSON.stringify(configs)).toBe(before);
          expect(JSON.stringify(configs)).toContain(left.secretKey);
        });

        it("registers a storage whose root reference is missing in a failed state", async () => {
          const left = await fixture.storage("left");
          const configs: StorageConfig[] = [
            { uri: left.uri, adapter: "real", options: left.configOptions },
          ];
          const registry = new StorageRegistry(configs, { real: factory }, {
            async get() {
              return undefined;
            },
          });
          const result = await registry.acquire(left.uri, "panel:p1").then(
            () => null,
            (e) => e,
          );
          expect(result).toBeInstanceOf(Error);
          expect(registry.status(left.uri)).toBe("failed");
          expect(registry.failure(left.uri)).toMatch(/credential/i);
        });

        it("a failed storage does not take the others down", async () => {
          const left = await fixture.storage("left");
          const right = await fixture.storage("right");
          // Only `right`'s key is served, so `left` fails on a missing reference.
          const secrets = providerSecrets({ [right.secretKey]: () => right.rootSecret() });
          const registry = new StorageRegistry(
            [left, right].map((s) => ({
              uri: s.uri,
              adapter: "real",
              options: s.configOptions,
            })),
            { real: factory },
            secrets,
          );
          await registry.acquire(left.uri, "panel:p1").catch(() => undefined);
          const handle = await registry.acquire(right.uri, "panel:p2");
          expect(handle.api).toBeDefined();
          expect(registry.status(right.uri)).toBe("ready");
          expect(registry.status(left.uri)).toBe("failed");
        });
      });

      describe("capabilities are declared, not probed", () => {
        it("defaults to full capability and never constructs the adapter to find out", async () => {
          const left = await fixture.storage("left");
          const { registry, constructions } = registryOver([left]);
          expect(registry.caps(left.uri)).toEqual({
            read: true,
            write: true,
            list: true,
            move: true,
            copy: true,
            remove: true,
            stat: { size: true, mtime: true },
          });
          expect(constructions[left.uri]).toBeUndefined(); // nothing was constructed
        });

        it("lets a pseudo-storage declare that most operations are unavailable", async () => {
          const left = await fixture.storage("left");
          const { registry } = registryOver([left], [
            {
              uri: "zip://out",
              adapter: "real",
              options: {},
              caps: { read: false, list: false, write: true },
            },
          ]);
          const declared = registry.caps("zip://out");
          expect(declared.write).toBe(true);
          expect(declared.read).toBe(false);
          expect(declared.list).toBe(false);
        });

        it("degrades the UI per storage: no date sort when mtime is not reported", async () => {
          const left = await fixture.storage("left");
          const { registry } = registryOver([left], [
            {
              uri: "s3://bucket",
              adapter: "real",
              options: {},
              caps: { stat: { size: true, mtime: false } },
            },
          ]);
          expect(registry.sortColumns(left.uri)).toEqual(["name", "size", "date"]);
          expect(registry.sortColumns("s3://bucket")).toEqual(["name", "size"]);
        });
      });

      it("serialisation key for the job queue is the storageURI itself", async () => {
        const left = await fixture.storage("left");
        const { registry } = registryOver([left]);
        const a = await registry.acquire(left.uri, "job:j1");
        const b = await registry.acquire(left.uri, "job:j2");
        expect(a.uri).toBe(b.uri);
      });
    });

    // ---------------------------------------------------------------- P3 ----

    describe("P3 · job engine", () => {
      let source: StorageFixture;
      let targetStore: StorageFixture;
      let target: SpyFiles;
      let job: JobModel;

      const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
        operation: "copy",
        source: { uri: source.uri, api: source.api },
        target: { uri: targetStore.uri, api: target, path: "/dst" },
        roots: ["/src"],
        batchSize: 4,
        job,
        ...over,
      });

      beforeEach(async () => {
        source = await fixture.storage("p3-src");
        targetStore = await fixture.storage("p3-dst");
        target = new SpyFiles(targetStore.api);
        job = new JobModel("j1");
        await seed(source.api, 10);
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
          const same = await fixture.storage("p3-same");
          await seed(same.api, 3);
          const spy = new SpyFiles(same.api);
          await runCopyJob(
            spec({
              operation: "move",
              source: { uri: same.uri, api: spy },
              target: { uri: same.uri, api: spy, path: "/dst" },
            }),
          );
          expect(spy.nativeMoves).toBe(3);
          expect(spy.writes.length).toBe(0); // no read/write round trip
        });

        /**
         * §6.5 — the adopted form of this case and the next one both read
         * `target.writes`, which is COMPLETION order inside a parallel batch, and
         * compared it to sorted order. That is the one thing §6.5 says not to
         * assert, and on a real adapter it fails intermittently: three files in
         * one batch of four complete in whatever order the filesystem finishes
         * them, and `/dst/sub/deep/three.txt` beat `/dst/one.txt` on 1 of 3 runs.
         *
         * What the engine actually promises is ENUMERATION order — it sorts
         * rather than trusting `list()` — and that is what `onBatch` reports. So
         * the promised order is asserted directly instead of being inferred from
         * an unpromised one, and the per-item fact (every entry landed) is
         * asserted as a set. Strictly more than the adopted form checked.
         */
        it("enumerates in deterministic sorted order, not list() order", async () => {
          const shuffled = await fixture.storage("p3-shuf");
          // Written z, a, m on purpose: a real adapter's `list()` order is its
          // own business, and the engine sorting rather than trusting it is the
          // claim. On mem this was already true; here it is also tested.
          await writeText(shuffled.api, "/src/z.txt", "z");
          await writeText(shuffled.api, "/src/a.txt", "a");
          await writeText(shuffled.api, "/src/m.txt", "m");
          const enumerated: string[] = [];
          await runCopyJob(
            spec({
              source: { uri: shuffled.uri, api: shuffled.api },
              onBatch: (b) => enumerated.push(...b),
            }),
          );
          expect(enumerated).toEqual(["/src/a.txt", "/src/m.txt", "/src/z.txt"]);
          expect([...target.writes].sort()).toEqual([
            "/dst/a.txt",
            "/dst/m.txt",
            "/dst/z.txt",
          ]);
        });

        it("walks whole directory trees, recreating structure", async () => {
          const tree = await fixture.storage("p3-tree");
          await writeText(tree.api, "/src/one.txt", "1");
          await writeText(tree.api, "/src/sub/two.txt", "2");
          await writeText(tree.api, "/src/sub/deep/three.txt", "3");
          const enumerated: string[] = [];
          await runCopyJob(
            spec({
              source: { uri: tree.uri, api: tree.api },
              onBatch: (b) => enumerated.push(...b),
            }),
          );
          expect(enumerated).toEqual([
            "/src/one.txt",
            "/src/sub/deep/three.txt",
            "/src/sub/two.txt",
          ]);
          expect([...target.writes].sort()).toEqual([
            "/dst/one.txt",
            "/dst/sub/deep/three.txt",
            "/dst/sub/two.txt",
          ]);
          // The structure really is on the target, not merely reported written.
          expect(await listPaths(targetStore.api, "/dst")).toEqual([
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
          const big = await fixture.storage("p3-big");
          await seed(big.api, 100);
          await runCopyJob(
            spec({
              source: { uri: big.uri, api: big.api },
              batchSize: 4,
              onBatch: cancelOnBatch(job, 2),
            }),
          );
          expect(job.status).toBe("cancelled");
          expect(job.completed).toBeLessThan(100);
          expect(job.completed % 4).toBe(0); // a clean batch boundary
          expect(job.completed).toBeGreaterThan(0); // it really did start
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
          const src = await fixture.storage("p3-mv");
          await seed(src.api, 6);
          const spy = new SpyFiles(src.api);
          const order: string[] = [];
          await runCopyJob(
            spec({
              operation: "move",
              source: { uri: src.uri, api: spy },
              onEntry: (path, phase) => order.push(`${phase}:${path}`),
            }),
          );
          // §6.5 — parallel batches interleave, so the invariant is PER ENTRY,
          // not global pairing: each entry's removal follows its own write, and
          // every write has a removal. A trailing delete pass would put all
          // removals last.
          expect(order.filter((o) => o.startsWith("removed:")).length).toBe(6);
          for (const path of new Set(order.map((o) => o.split(":")[1]))) {
            expect(order.indexOf(`wrote:${path}`)).toBeLessThan(order.indexOf(`removed:${path}`));
          }
          const lastWrite = order.map((o) => o.startsWith("wrote:")).lastIndexOf(true);
          const firstRemove = order.map((o) => o.startsWith("removed:")).indexOf(true);
          expect(firstRemove).toBeLessThan(lastWrite); // interleaved, not two passes
        });

        it("reports a precise boundary when cancelled, and the source keeps the rest", async () => {
          const src = await fixture.storage("p3-bnd");
          await seed(src.api, 40);
          const spy = new SpyFiles(src.api);
          const batchSize = 2;
          await runCopyJob(
            spec({
              operation: "move",
              source: { uri: src.uri, api: spy },
              batchSize,
              onBatch: cancelOnBatch(job, 3),
            }),
          );
          expect(job.status).toBe("cancelled");
          expect(job.completed).toBeGreaterThan(0); // it really did move something

          // TIGHTENED, not relaxed — see `ADAPTERS.md` §"the two assertions that
          // could not cross unchanged". The adopted form asserted
          // `removed.length === completed`, which holds only when no transfer
          // suspends across a batch boundary: `job.completed` advances a whole
          // batch at a time, so on a real adapter a cancellation landing inside
          // a batch leaves up to `batchSize - 1` entries moved but uncounted.
          // What is actually promised is the WINDOW, plus the two facts the
          // adopted equality let the test derive for free. All three are checked.
          expect(spy.removed.length).toBeGreaterThanOrEqual(job.completed);
          expect(spy.removed.length).toBeLessThan(job.completed + batchSize);
          // Nothing was removed from the source whose target does not exist.
          for (const removedPath of spy.removed) {
            const targetPath = removedPath.replace("/src/", "/dst/");
            expect(await targetStore.api.exists(targetPath)).toBe(true);
          }
          // The source retains exactly what was not moved.
          const remaining = await listPaths(spy, "/src");
          expect(remaining.length).toBe(40 - spy.removed.length);
          expect(job.boundary()).toBe(`moved ${job.completed} of 40, source retains the rest`);
        });

        it("never removes a source entry before its target write completed", async () => {
          const src = await fixture.storage("p3-nomv");
          await seed(src.api, 5);
          const spy = new SpyFiles(src.api);
          target.failOn = "/dst/f0003.txt";
          await runCopyJob(
            spec({ operation: "move", source: { uri: src.uri, api: spy }, batchSize: 1 }),
          );
          expect(spy.removed).not.toContain("/src/f0003.txt");
        });
      });

      it("releases the event loop so the UI is not frozen", async () => {
        const big = await fixture.storage("p3-loop");
        await seed(big.api, 60);
        let ticks = 0;
        const timer = setInterval(() => ticks++, 0);
        await runCopyJob(spec({ source: { uri: big.uri, api: big.api }, batchSize: 4 }));
        clearInterval(timer);
        expect(ticks).toBeGreaterThan(0);
      });
    });

    // ---------------------------------------------------------------- P4 ----

    describe("P4 · checkpoint and resume", () => {
      let source: StorageFixture;
      let target: StorageFixture;
      let store: CountingFiles;
      let checkpoints: CheckpointStore;

      const spec = (job: JobModel, over: Partial<JobSpec> = {}): JobSpec => ({
        operation: "copy",
        source: { uri: source.uri, api: source.api },
        target: { uri: target.uri, api: target.api, path: "/dst" },
        roots: ["/src"],
        batchSize: 4,
        job,
        checkpoints,
        ...over,
      });

      beforeEach(async () => {
        source = await fixture.storage("p4-src");
        target = await fixture.storage("p4-dst");
        // The checkpoint lives in a host-provided FilesApi, separate from any
        // storage in the job — and on this adapter that is a real one too.
        const host = await fixture.storage("p4-jobs");
        store = new CountingFiles(host.api);
        checkpoints = new CheckpointStore(store);
        await seed(source.api, 20);
      });

      it("writes the cursor after EVERY batch, not on a flush interval", async () => {
        const job = new JobModel("j1");
        await runCopyJob(spec(job));
        expect(store.writes).toBe(5); // 20 entries / batch 4 — one cursor write per batch
        const cursor = await checkpoints.load("j1");
        expect(cursor).toBeUndefined(); // completed jobs leave nothing behind
      });

      it("cursor cost is flat per batch, not quadratic in entries", async () => {
        const ten = await fixture.storage("p4-10");
        await seed(ten.api, 10);
        const job1 = new JobModel("small");
        await runCopyJob(spec(job1, { batchSize: 1, source: { uri: ten.uri, api: ten.api } }));
        const tenBatches = store.bytes;

        store.bytes = 0;
        const twenty = await fixture.storage("p4-20");
        await seed(twenty.api, 20);
        const job2 = new JobModel("big");
        await runCopyJob(spec(job2, { batchSize: 1, source: { uri: twenty.uri, api: twenty.api } }));
        const twentyBatches = store.bytes;

        // A growing completed-list is O(n²); a cursor is O(n) with a bounded record.
        expect(twentyBatches).toBeLessThan(tenBatches * 3);
      });

      it("holds lastCompletedBatch, cursorPath and the spec", async () => {
        const job = new JobModel("j2");
        await runCopyJob(spec(job, { onBatch: cancelOnBatch(job, 2) }));

        const cursor = (await checkpoints.load("j2"))!;
        expect(cursor.lastCompletedBatch).toBeGreaterThanOrEqual(0);
        expect(cursor.cursorPath).toMatch(/^\/src\/f\d{4}\.txt$/);
        expect(cursor.spec.target.path).toBe("/dst");
        expect(cursor.spec.operation).toBe("copy");
      });

      it("records skipped entries in errors.json, which a cursor cannot express", async () => {
        const job = new JobModel("j3");
        await runCopyJob(spec(job, { batchSize: 2, shouldSkip: (p) => p.endsWith("0003.txt") }));
        const errors = await checkpoints.errors("j3");
        expect(errors).toEqual([{ path: "/src/f0003.txt", reason: "skipped" }]);
        expect(await target.api.exists("/dst/f0003.txt")).toBe(false);
        expect(job.status).toBe("done");
      });

      describe("resume", () => {
        it("re-enqueues and copies every remaining entry exactly once", async () => {
          const first = new JobModel("j4");
          await runCopyJob(spec(first, { onBatch: cancelOnBatch(first, 2) }));
          expect(first.completed).toBeLessThan(20);
          expect(first.completed).toBeGreaterThan(0);

          const copiedBefore = await listPaths(target.api, "/dst");

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
          const all = await listPaths(target.api, "/dst");
          expect(all.length).toBe(20);
          expect(new Set(all).size).toBe(20);
        });

        it("keeps the cursor when cancellation lands during the FINAL batch", async () => {
          // §5.3's final-iteration shape. The in-loop abort check covers early
          // cancellation; this is the other path — the loop runs to completion
          // and only then sees the abort. A cursor cleared here would make the
          // job unresumable.
          const eight = await fixture.storage("p4-final");
          await seed(eight.api, 8);
          const job = new JobModel("j-last");
          await runCopyJob(
            spec(job, {
              source: { uri: eight.uri, api: eight.api },
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
            const freshTarget = await fixture.storage(`p4-rep-${run}`);
            const job = new JobModel(`rep-${run}`);
            const seen: string[] = [];
            await runCopyJob(
              spec(job, {
                target: { uri: freshTarget.uri, api: freshTarget.api, path: "/dst" },
                onBatch: (b) => seen.push(...b),
              }),
            );
            order.push(seen);
          }
          expect(order[0]).toEqual(order[1]);
        });

        it("reports interrupted jobs at startup", async () => {
          const job = new JobModel("j5");
          await runCopyJob(spec(job, { onBatch: cancelOnBatch(job, 2) }));

          const interrupted = await checkpoints.listInterrupted();
          expect(interrupted.map((r) => r.jobId)).toEqual(["j5"]);
          expect(interrupted[0].remaining).toBe(20 - job.completed);
        });

        /**
         * The precondition the six converted cases used to leave implicit, now
         * asserted as the fact it is.
         *
         * A job cancelled before its FIRST batch completes writes no cursor, so
         * it is neither reported at startup nor resumable — and that is correct
         * rather than a defect: it made no progress, so re-enqueueing it is
         * identical to enqueueing it fresh, which the second half of this case
         * checks. It is recorded here because on a real adapter it is the LIKELY
         * outcome, not an edge: enumeration of a large tree is the longest part
         * of a job and therefore the most probable moment to be interrupted,
         * while on `MemFilesApi` the window does not exist at all.
         */
        it("a job cancelled during enumeration leaves no cursor, and re-runs whole", async () => {
          const job = new JobModel("j-none");
          // Cancelled SYNCHRONOUSLY after the call, so the abort lands while
          // `enumerate()` is still awaiting — the only window in which no batch
          // has begun. Cancelling at the start of batch 0 does NOT reach it: the
          // loop's abort check sits at the top of the iteration, already passed,
          // so that batch runs to completion and saves its cursor. That is what
          // this case originally asserted and it was wrong; the engine's actual
          // behaviour is the stronger of the two and is pinned here.
          const run = runCopyJob(spec(job));
          job.cancel();
          await run;
          expect(job.status).toBe("cancelled");
          expect(job.completed).toBe(0);
          expect(await checkpoints.load("j-none")).toBeUndefined();
          expect(await checkpoints.listInterrupted()).toEqual([]);

          const again = new JobModel("j-none-again");
          await runCopyJob(spec(again, { resumeFrom: "j-none" }));
          expect(again.status).toBe("done");
          expect((await listPaths(target.api, "/dst")).length).toBe(20);
        });
      });
    });

    // ---------------------------------------------------------------- P5 ----

    describe("P5 · conflicts", () => {
      let source: StorageFixture;
      let target: StorageFixture;
      let job: JobModel;

      const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
        operation: "copy",
        source: { uri: source.uri, api: source.api },
        target: { uri: target.uri, api: target.api, path: "/dst" },
        roots: ["/src"],
        batchSize: 2,
        job,
        ...over,
      });

      beforeEach(async () => {
        source = await fixture.storage("p5-src");
        target = await fixture.storage("p5-dst");
        for (const [path, body] of [
          ["/src/a.txt", "new-a"],
          ["/src/b.txt", "new-b"],
          ["/src/c.txt", "new-c"],
        ]) {
          await writeText(source.api, path, body);
        }
        for (const [path, body] of [
          ["/dst/a.txt", "old-a"],
          ["/dst/b.txt", "old-b"],
        ]) {
          await writeText(target.api, path, body);
        }
        job = new JobModel("j");
      });

      it("asks only about entries that actually conflict", async () => {
        const asked: string[] = [];
        await runCopyJob(
          spec({
            onConflict: async (entry) => {
              asked.push(entry.path);
              return { resolution: "overwrite", applyToAll: false };
            },
          }),
        );
        expect(asked.sort()).toEqual(["/src/a.txt", "/src/b.txt"]); // c.txt does not exist yet
      });

      it("honours overwrite, skip and rename per entry", async () => {
        const answers: Record<string, ConflictResolution> = {
          "/src/a.txt": { resolution: "overwrite", applyToAll: false },
          "/src/b.txt": { resolution: "skip", applyToAll: false },
        };
        await runCopyJob(spec({ batchSize: 1, onConflict: async (e) => answers[e.path] }));

        expect(await readText(target.api, "/dst/a.txt")).toBe("new-a");
        expect(await readText(target.api, "/dst/b.txt")).toBe("old-b");
        expect(await readText(target.api, "/dst/c.txt")).toBe("new-c");
      });

      it("renames rather than overwriting when asked", async () => {
        await runCopyJob(
          spec({
            batchSize: 1,
            onConflict: async () => ({ resolution: "rename", applyToAll: true }),
          }),
        );
        expect(await readText(target.api, "/dst/a.txt")).toBe("old-a");
        expect(await readText(target.api, "/dst/a (2).txt")).toBe("new-a");
      });

      it("caches applyToAll: 50 conflicts are not asked 50 times", async () => {
        // §6.3 — a decision the user makes inside concurrent work has exactly
        // one in-flight instance. Under real latency this is a genuine race
        // rather than a microtask-ordering detail, which is why this case is the
        // one worth running on a real adapter at all.
        const manySrc = await fixture.storage("p5-many-src");
        const manyDst = await fixture.storage("p5-many-dst");
        for (let i = 0; i < 50; i++) {
          await writeText(manySrc.api, `/src/f${i}.txt`, "new");
          await writeText(manyDst.api, `/dst/f${i}.txt`, "old");
        }

        let asked = 0;
        await runCopyJob(
          spec({
            batchSize: 4,
            source: { uri: manySrc.uri, api: manySrc.api },
            target: { uri: manyDst.uri, api: manyDst.api, path: "/dst" },
            onConflict: async () => {
              asked++;
              return { resolution: "skip", applyToAll: true };
            },
          }),
        );
        expect(asked).toBe(1);
        expect(await readText(manyDst.api, "/dst/f0.txt")).toBe("old");
      });

      it("uses a plain conflictPolicy when no callback is supplied", async () => {
        await runCopyJob(spec({ conflictPolicy: "skip" }));
        expect(await readText(target.api, "/dst/a.txt")).toBe("old-a");
        expect(await readText(target.api, "/dst/c.txt")).toBe("new-c");
      });

      it("interrupts a pending decision when the job is cancelled", async () => {
        let aborted = false;
        // The dialog announces that it is open, and only then is the job
        // cancelled. The adopted `setTimeout(0)` stood in for this and on a real
        // adapter frequently cancelled the job before `onConflict` was ever
        // reached — at which point "a pending decision" did not exist and the
        // case was passing on the wrong state.
        let dialogOpen!: () => void;
        const opened = new Promise<void>((resolve) => {
          dialogOpen = resolve;
        });
        const run = runCopyJob(
          spec({
            batchSize: 1,
            onConflict: (_entry, signal) =>
              new Promise((_resolve, reject) => {
                // A dialog that is never answered by the user.
                signal.addEventListener("abort", () => {
                  aborted = true;
                  reject(new Error("decision aborted"));
                });
                dialogOpen();
              }),
          }),
        );
        await opened;
        job.cancel();
        await run;

        expect(aborted).toBe(true);
        expect(job.status).toBe("cancelled");
        expect(await readText(target.api, "/dst/a.txt")).toBe("old-a"); // untouched
      });

      it("records skipped entries as job errors, not as failures", async () => {
        await runCopyJob(spec({ conflictPolicy: "skip" }));
        expect(job.status).toBe("done");
        expect(job.skipped.sort()).toEqual(["/src/a.txt", "/src/b.txt"]);
      });
    });

    // ---------------------------------------------------------------- P6 ----

    describe("P6 · job queue", () => {
      let a: StorageFixture;
      let b: StorageFixture;
      let c: StorageFixture;
      let registry: StorageRegistry;
      let queue: JobQueue;
      let timeline: string[];

      beforeEach(async () => {
        a = await fixture.storage("p6-a");
        b = await fixture.storage("p6-b");
        c = await fixture.storage("p6-c");
        await seed(a.api, 8);
        registry = registryOver([a, b, c], [
          { uri: "missing://nowhere", adapter: "real", options: {} },
        ]).registry;
        timeline = [];
        queue = new JobQueue(registry, { batchSize: 2 });
      });

      const copy = (label: string, targetUri: string) =>
        queue.enqueue({
          operation: "copy",
          sourceUri: a.uri,
          targetUri,
          roots: ["/src"],
          targetPath: `/${label}`,
          hooks: {
            onStart: () => timeline.push(`start:${label}`),
            onEnd: () => timeline.push(`end:${label}`),
          },
        });

      it("serialises mutating jobs that target the same storage", async () => {
        const one = copy("one", b.uri);
        const two = copy("two", b.uri);
        await Promise.all([one.done, two.done]);
        expect(timeline).toEqual(["start:one", "end:one", "start:two", "end:two"]);
      });

      it("runs jobs on different storages in parallel", async () => {
        const one = copy("one", b.uri);
        const two = copy("two", c.uri);
        await Promise.all([one.done, two.done]);
        // both started before either ended
        expect(timeline.slice(0, 2).sort()).toEqual(["start:one", "start:two"]);
      });

      it("exposes a global activity surface of live jobs", async () => {
        const one = copy("one", b.uri);
        const two = copy("two", c.uri);
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
        const one = copy("one", b.uri);
        const two = copy("two", c.uri);
        one.cancel();
        await Promise.all([one.done, two.done]);
        expect(one.status).toBe("cancelled");
        expect(two.status).toBe("done");
      });

      it("never starts a queued job that was cancelled while waiting", async () => {
        const one = copy("one", b.uri);
        const two = copy("two", b.uri);
        two.cancel();
        await Promise.all([one.done, two.done]);
        expect(timeline).toEqual(["start:one", "end:one"]);
        expect(two.status).toBe("cancelled");
        expect(two.completed).toBe(0);
      });

      describe("jobs are independent of panels", () => {
        it("keeps BOTH endpoints alive after the panels that started it are removed", async () => {
          await registry.acquire(a.uri, "panel:p1"); // source panel
          await registry.acquire(b.uri, "panel:p2"); // target panel
          const job = copy("one", b.uri);

          // Both panels close in the same tick the copy was requested. The job's
          // refcounts must already be pinned, or an instance is disposed under it.
          registry.release(a.uri, "panel:p1");
          registry.release(b.uri, "panel:p2");
          expect(registry.isLive(a.uri)).toBe(true);
          expect(registry.isLive(b.uri)).toBe(true);

          await job.done;
          expect(job.status).toBe("done");
          expect(registry.isLive(b.uri)).toBe(false); // released when the job ended
        });

        it("releases both endpoints exactly once when the job ends", async () => {
          const job = copy("one", b.uri);
          await job.done;
          expect(registry.isLive(a.uri)).toBe(false);
          expect(registry.isLive(b.uri)).toBe(false);
        });

        it("reports a storage that cannot be acquired without killing the queue", async () => {
          const bad = queue.enqueue({
            operation: "copy",
            sourceUri: a.uri,
            targetUri: "missing://nowhere",
            roots: ["/src"],
            targetPath: "/x",
          });
          await bad.done;
          expect(bad.status).toBe("failed");
          // The reason must name the storage, not a generic end-of-job message.
          expect(bad.error).toContain("missing://nowhere");

          const good = copy("after", b.uri);
          await good.done;
          expect(good.status).toBe("done");
        });
      });
    });
  });
}
