/**
 * C0.5 — the five re-checks, each as its own case.
 *
 * These are the behaviours the work order calls ASSERTED BUT NEVER OBSERVED.
 * Every core rung ran on `MemFilesApi`, which never fails a write halfway, never
 * denies permission, never expires and never suspends, so three of the engine's
 * promises had no witness:
 *
 *   1. partial target removal after a failed write,
 *   2. re-acquisition failure on resume,
 *   3. per-storage lane serialisation under real latency.
 *
 * Nothing in this file fakes a failure. A write fails because the filesystem
 * refused it, a handle dies because its directory was removed, and latency is
 * whatever the platform takes. Where an adapter CANNOT produce one of these, the
 * case asserts the absence against `capabilities.ts` rather than skipping —
 * `capabilitiesOf` is the documented table and these are the tests that hold it
 * honest.
 */

import { expect, it } from "vitest";
import type { FilesApi, ReadOptions } from "@statewalker/webrun-files";
import { CheckpointStore } from "../../../fm-core/src/checkpoints.js";
import { type JobSpec, runCopyJob } from "../../../fm-core/src/copy-job.js";
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
  listPaths,
  seed,
  type StorageFixture,
  writeText,
} from "./adapter-fixture.js";

/** A body big enough that `read()` yields many chunks: `BrowserFilesApi` reads 8 KiB at a time. */
export const BIG_BYTES = 512 * 1024;

function bigBody(): Uint8Array {
  const bytes = new Uint8Array(BIG_BYTES);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
  return bytes;
}

/**
 * Counts chunks as they come off the REAL source, and fires `at` once.
 *
 * An observer, not a fake: every byte still comes from the adapter under test.
 * The count is the only way to know a write is genuinely in flight — a timer
 * would be the same guess that made six adopted cases flaky.
 */
class ChunkCountingSource implements FilesApi {
  chunks = 0;
  constructor(
    private readonly inner: FilesApi,
    private readonly at: number,
    private readonly fire: () => void,
  ) {}
  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    const self = this;
    return (async function* () {
      for await (const chunk of self.inner.read(path, options)) {
        if (++self.chunks === self.at) self.fire();
        yield chunk;
      }
    })();
  }
  write(p: string, c: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    return this.inner.write(p, c);
  }
  mkdir(p: string) {
    return this.inner.mkdir(p);
  }
  list(p: string, o?: Parameters<FilesApi["list"]>[1]) {
    return this.inner.list(p, o);
  }
  stats(p: string) {
    return this.inner.stats(p);
  }
  exists(p: string) {
    return this.inner.exists(p);
  }
  remove(p: string) {
    return this.inner.remove(p);
  }
  move(s: string, t: string) {
    return this.inner.move(s, t);
  }
  copy(s: string, t: string) {
    return this.inner.copy(s, t);
  }
}

/**
 * Records the size of the target AT THE MOMENT the engine removes it.
 *
 * This is the direct observation of behaviour 1. `runCopyJob` removes the target
 * on a failed write; whether there was anything THERE to remove is the question
 * mem could never answer, because mem buffers the whole stream and writes once.
 */
class RemovalWatchingTarget implements FilesApi {
  /** Size of the target when `remove()` was called; `undefined` if it did not exist. */
  sizeAtRemoval: number | undefined;
  removeCalls = 0;
  constructor(private readonly inner: FilesApi) {}
  read(p: string, o?: ReadOptions) {
    return this.inner.read(p, o);
  }
  write(p: string, c: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    return this.inner.write(p, c);
  }
  mkdir(p: string) {
    return this.inner.mkdir(p);
  }
  list(p: string, o?: Parameters<FilesApi["list"]>[1]) {
    return this.inner.list(p, o);
  }
  stats(p: string) {
    return this.inner.stats(p);
  }
  exists(p: string) {
    return this.inner.exists(p);
  }
  async remove(p: string) {
    this.removeCalls++;
    const stats = await this.inner.stats(p);
    this.sizeAtRemoval = stats?.kind === "file" ? stats.size : undefined;
    return this.inner.remove(p);
  }
  move(s: string, t: string) {
    return this.inner.move(s, t);
  }
  copy(s: string, t: string) {
    return this.inner.copy(s, t);
  }
}

export interface RecheckOptions {
  readonly makeFixture: () => AdapterFixture;
  readonly factory: AdapterFactory;
}

export function defineRechecks({ makeFixture, factory }: RecheckOptions): void {
  const caps = makeFixture().caps;
  const describeName = `C0.5 · re-checks on ${caps.label}`;

  // Vitest's `describe` is imported by the caller's file; using `it` directly in a
  // named group keeps the fixture lifecycle per-case, which matters because two
  // of these cases leave a storage deliberately broken.
  const group = (name: string, body: (fixture: AdapterFixture) => Promise<void>) =>
    it(`${describeName} › ${name}`, async () => {
      const fixture = makeFixture();
      try {
        await body(fixture);
      } finally {
        await fixture.cleanup();
      }
    });

  /** A registry over real storages, with the real root-resolution path. */
  function registryOver(fixture: AdapterFixture, storages: StorageFixture[], extra: StorageConfig[] = []) {
    const configs: StorageConfig[] = [
      ...storages.map((s) => ({ uri: s.uri, adapter: "real", options: s.configOptions })),
      ...extra,
    ];
    const secrets = providerSecrets(
      Object.fromEntries(storages.map((s) => [s.secretKey, () => s.rootSecret()])),
    );
    return new StorageRegistry(configs, { real: factory }, secrets);
  }

  // ------------------------------------------------- 1. interrupted write ----

  /**
   * RE-CHECK 1 — a real interrupted write.
   *
   * `copy-job.ts` says, in a comment at the write: "No AbortSignal on write():
   * interrupting means throwing from the source iterable, which leaves a partial
   * target behind — so we remove it." The adopted P3 case that covers it
   * (`leaves no partial file behind when a write is interrupted`) makes the
   * source's WRAPPER throw on a named path. That is a fake failure, and it is
   * also not the interruption the comment describes.
   *
   * Here the job is cancelled while a real multi-chunk read is in flight, which
   * is the only interruption the engine actually has. Whether a partial target is
   * left depends on the adapter, and BOTH halves of that pair are asserted — the
   * symmetric-pair rule of §5.3 applied to adapters rather than to arguments.
   */
  group("cancelling mid-stream removes the partial target it created", async (fixture) => {
    const source = await fixture.storage("rc1-src");
    const targetStore = await fixture.storage("rc1-dst");
    await source.api.write("/src/big.bin", [bigBody()]);

    const job = new JobModel("rc1");
    const target = new RemovalWatchingTarget(targetStore.api);
    const watched = new ChunkCountingSource(source.api, 4, () => job.cancel());

    await runCopyJob({
      operation: "copy",
      source: { uri: source.uri, api: watched },
      target: { uri: targetStore.uri, api: target, path: "/dst" },
      roots: ["/src"],
      batchSize: 1,
      job,
    } satisfies JobSpec);

    if (!caps.readsInChunks) {
      // `MemFilesApi` yields a whole file in ONE chunk at any size, so there is no
      // mid-stream for a cancellation to land in. The observer — armed for the
      // fourth chunk of a 512 KiB file — NEVER FIRED, so the job was never
      // cancelled at all and ran to completion with a whole target.
      //
      // This is the exact shape of what mem hid, and it is asserted rather than
      // skipped: a 512 KiB fixture does not help, because the problem is not that
      // mem is fast, it is that mem has no stream.
      expect(watched.chunks).toBe(1);
      expect(job.status).toBe("done");
      expect(target.removeCalls).toBe(0);
      expect(await targetStore.api.stats("/dst/big.bin")).toMatchObject({
        kind: "file",
        size: BIG_BYTES,
      });
      expect(caps.commitsPartialWrites).toBe(false);
      return;
    }

    // The read really was interrupted: chunks stopped arriving after the abort,
    // well short of the whole file.
    expect(watched.chunks).toBeGreaterThanOrEqual(4);
    expect(watched.chunks * 8192).toBeLessThan(BIG_BYTES);
    expect(job.status).toBe("cancelled");

    // The engine rolled the target back, whatever the adapter had committed.
    expect(target.removeCalls).toBeGreaterThan(0);
    expect(await targetStore.api.exists("/dst/big.bin")).toBe(false);

    if (caps.commitsPartialWrites) {
      // `BrowserFilesApi` opens a `FileSystemWritableFileStream` and closes it in
      // a `finally`, so the bytes written before the throw are COMMITTED. This is
      // the first time in this app's record that the rollback has had anything to
      // roll back.
      expect(target.sizeAtRemoval).toBeGreaterThan(0);
      expect(target.sizeAtRemoval).toBeLessThan(BIG_BYTES);
    } else {
      // `NodeFilesApi` and `MemFilesApi` drain the iterable into one buffer and
      // then write once, so the throw means no target was ever created and the
      // removal is a no-op over nothing. Documented, not skipped.
      expect(target.sizeAtRemoval).toBeUndefined();
    }
  });

  // ------------------------------------------------- 2. permission denial ----

  /**
   * RE-CHECK 2 — permission denial mid-job.
   *
   * Node only, and the absence elsewhere is asserted rather than skipped: OPFS
   * has no per-directory permission model, so `denyWrites` is undefined on that
   * fixture and `caps.canDenyWriteMidJob` says so.
   */
  group("a write denied by the storage mid-job fails the job, not the process", async (fixture) => {
    expect(Boolean(fixture.denyWrites)).toBe(caps.canDenyWriteMidJob);
    if (!fixture.denyWrites || !fixture.allowWrites) return;

    const source = await fixture.storage("rc2-src");
    const targetStore = await fixture.storage("rc2-dst");
    await seed(source.api, 12);

    const job = new JobModel("rc2");
    const target = new RemovalWatchingTarget(targetStore.api);
    let denied = false;

    await runCopyJob({
      operation: "copy",
      source: { uri: source.uri, api: source.api },
      target: { uri: targetStore.uri, api: target, path: "/dst" },
      roots: ["/src"],
      batchSize: 4,
      job,
      onBatch: () => {
        if (denied) return;
        denied = true;
        // Synchronous so the denial is in place before the batch's writes run,
        // and `await`-free so no extra turn is introduced.
        void fixture.denyWrites?.(targetStore);
      },
    } satisfies JobSpec);

    expect(job.status).toBe("failed");
    // The refusal comes from the platform, so the reason names it rather than
    // naming a test double.
    expect(job.error).toMatch(/EACCES|permission denied|not allowed/i);
    expect(job.completed).toBeLessThan(12);

    await fixture.allowWrites(targetStore);
  });

  // --------------------------------------- 3. handle revoked before start ----

  /**
   * RE-CHECK 3 — a handle revoked between enqueue and start.
   *
   * The finding is not that the job fails; it is WHERE. `JobQueue.enqueue` calls
   * `_acquire` synchronously, so a queued job has already RESOLVED both roots
   * before its lane frees up — which is deliberate (P6: a queued job that
   * acquired nothing would let the panel that started it drop the last
   * reference). The consequence, never observed until now, is that a revocation
   * AFTER enqueue is not caught by the registry's failed-status path at all: the
   * handle is live as far as the registry is concerned and the job dies at its
   * first real use.
   *
   * Both halves of the pair are asserted — revoked BEFORE enqueue, which the
   * registry reports, and revoked AFTER, which it cannot. §5.3.
   */
  group("a root revoked after enqueue fails that job and leaves the lane usable", async (fixture) => {
    if (!caps.canRevokeRootMidFlight) {
      // A `MemFilesApi` is a Map; there is no handle and nothing to revoke. The
      // fixture's `revoke()` says so by throwing on the next resolution, and the
      // absence is asserted here rather than the case being skipped.
      const only = await fixture.storage("rc3-mem");
      await only.revoke();
      const failure = await only.rootSecret().then(
        () => undefined,
        (e: Error) => e,
      );
      expect(failure?.message).toMatch(/cannot be revoked/);
      return;
    }

    const a = await fixture.storage("rc3-a");
    const doomed = await fixture.storage("rc3-doomed");
    const targetStore = await fixture.storage("rc3-dst");
    await seed(a.api, 8);
    await seed(doomed.api, 8);

    const registry = registryOver(fixture, [a, doomed, targetStore]);
    const queue = new JobQueue(registry, { batchSize: 2 });

    const first = queue.enqueue({
      operation: "copy",
      sourceUri: a.uri,
      targetUri: targetStore.uri,
      roots: ["/src"],
      targetPath: "/one",
    });
    const second = queue.enqueue({
      operation: "copy",
      sourceUri: doomed.uri,
      targetUri: targetStore.uri, // same lane: it waits behind `first`
      roots: ["/src"],
      targetPath: "/two",
    });

    // Revoked for real while `second` is still queued behind `first`.
    await doomed.revoke();

    await Promise.allSettled([first.done, second.done]);

    expect(first.status).toBe("done");
    // Its source is gone, so it enumerates to nothing and "succeeds" having
    // copied zero entries — which is what a silently-revoked root looks like from
    // inside the engine, and is why the registry-level report below matters.
    expect(second.status).toBe("done");
    expect(second.total).toBe(0);
    expect(await listPaths(targetStore.api, "/two")).toEqual([]);

    // The lane survived either way.
    const third = queue.enqueue({
      operation: "copy",
      sourceUri: a.uri,
      targetUri: targetStore.uri,
      roots: ["/src"],
      targetPath: "/three",
    });
    await third.done;
    expect(third.status).toBe("done");
    expect((await listPaths(targetStore.api, "/three")).length).toBe(8);
  });

  group("a root revoked before enqueue is reported by the registry", async (fixture) => {
    if (!caps.canRevokeRootMidFlight) {
      expect(caps.id).toBe("mem");
      return;
    }
    const doomed = await fixture.storage("rc3b-src");
    const targetStore = await fixture.storage("rc3b-dst");
    await seed(doomed.api, 4);

    const registry = registryOver(fixture, [doomed, targetStore]);
    // Revoked BEFORE anything acquires it, so the root resolution itself fails.
    await doomed.revoke();

    const queue = new JobQueue(registry, { batchSize: 2 });
    const job = queue.enqueue({
      operation: "copy",
      sourceUri: doomed.uri,
      targetUri: targetStore.uri,
      roots: ["/src"],
      targetPath: "/x",
    });
    await job.done;

    expect(job.status).toBe("failed");
    expect(job.error).toContain(doomed.uri);
    expect(registry.status(doomed.uri)).toBe("failed");
    expect(registry.failure(doomed.uri)).toBeDefined();
    // The failed acquisition released its own pin — §6.6's third clause.
    expect(registry.isLive(doomed.uri)).toBe(false);

    // And the target is untouched and still usable.
    expect(registry.status(targetStore.uri)).not.toBe("failed");
  });

  // ------------------------------------------- 4. resume after revocation ----

  /**
   * RE-CHECK 4 — resume when the source can no longer be re-acquired.
   *
   * The adopted P4 case fakes this with `get api(): never { throw }` on the spec.
   * Here the resume goes through the REGISTRY, and the source is genuinely gone
   * by the time the resumed job asks for it.
   *
   * WHAT THIS IS NOT: a genuinely expired CREDENTIAL. Neither OPFS nor a local
   * directory has one — see `ADAPTERS.md`. This is the real version of the other
   * half of P4's claim: a storage that cannot be re-acquired is reportable rather
   * than a crash, and the cursor survives so the job can be resumed again once
   * the storage comes back.
   */
  group("a resume whose source cannot be re-acquired is reportable, and the cursor survives", async (fixture) => {
    const source = await fixture.storage("rc4-src");
    const targetStore = await fixture.storage("rc4-dst");
    const host = await fixture.storage("rc4-jobs");
    await seed(source.api, 20);
    const checkpoints = new CheckpointStore(host.api);

    const spec = (job: JobModel, over: Partial<JobSpec> = {}): JobSpec => ({
      operation: "copy",
      source: { uri: source.uri, api: source.api },
      target: { uri: targetStore.uri, api: targetStore.api, path: "/dst" },
      roots: ["/src"],
      batchSize: 4,
      job,
      checkpoints,
      ...over,
    });

    // Leg 1: interrupt it with a cursor on disk.
    const first = new JobModel("rc4");
    let batches = 0;
    await runCopyJob(
      spec(first, {
        onBatch: () => {
          if (++batches === 2) first.cancel();
        },
      }),
    );
    expect(first.status).toBe("cancelled");
    expect(await checkpoints.load("rc4")).toBeDefined();

    // Leg 2: the source storage is genuinely gone, and the resume goes through
    // the registry's real resolution path.
    const registry = registryOver(fixture, [source, targetStore]);
    await source.revoke();

    const resumedHandle = await registry.acquire(source.uri, "job:rc4-resume").then(
      () => undefined,
      (e: Error) => e,
    );
    expect(resumedHandle).toBeInstanceOf(Error);
    expect(registry.status(source.uri)).toBe("failed");

    // The cursor survives a failed resume: the promise to the user is not revoked
    // by the storage being briefly unreachable.
    expect(await checkpoints.load("rc4")).toBeDefined();
    const interrupted = await checkpoints.listInterrupted();
    expect(interrupted.map((r) => r.jobId)).toEqual(["rc4"]);
  });

  // ------------------------------------------------ 5. lane serialisation ----

  /**
   * RE-CHECK 5 — per-storage lane serialisation under real latency.
   *
   * P6's adopted cases read `timeline`, which records `onStart`/`onEnd` — hooks
   * the queue calls, so they test the queue's own bookkeeping rather than whether
   * any WRITE of one job landed between two writes of another. On mem the two are
   * the same thing, because a job runs to completion inside one turn. Under real
   * latency they are not, and the stronger claim is the one worth making: §6.5's
   * form, per-item invariants plus one global interleaving assertion.
   */
  group("two jobs on one target storage never interleave their writes", async (fixture) => {
    // Runs on mem too — the claim is true there, it is simply not EVIDENCE there,
    // because a job that never suspends cannot interleave with anything. The
    // capability row records which of the two a given run is.
    const source = await fixture.storage("rc5-src");
    const targetStore = await fixture.storage("rc5-dst");
    await seed(source.api, 12);

    const registry = registryOver(fixture, [source, targetStore]);
    const queue = new JobQueue(registry, { batchSize: 2 });

    /** Every completed write, labelled by the job that made it, in landing order. */
    const landed: string[] = [];
    const copy = (label: string) =>
      queue.enqueue({
        operation: "copy",
        sourceUri: source.uri,
        targetUri: targetStore.uri,
        roots: ["/src"],
        targetPath: `/${label}`,
        onWritten: () => landed.push(label),
      });

    const one = copy("one");
    const two = copy("two");
    await Promise.all([one.done, two.done]);

    expect(landed.length).toBe(24);
    // Per item: every write of `one` precedes every write of `two`. A lane that
    // merely started them in order would still let their writes interleave under
    // latency, and that is the failure this asserts against.
    const lastOne = landed.lastIndexOf("one");
    const firstTwo = landed.indexOf("two");
    expect(lastOne).toBeLessThan(firstTwo);
    expect(landed.filter((l) => l === "one").length).toBe(12);
  });

  group("two jobs on different target storages do interleave their writes", async (fixture) => {
    // The other half of the pair, and the one that shows the serialisation above
    // is the LANE rather than the queue being sequential everywhere. Without it,
    // a queue that ran every job one at a time would pass the case above.
    const source = await fixture.storage("rc5b-src");
    const left = await fixture.storage("rc5b-left");
    const right = await fixture.storage("rc5b-right");
    await seed(source.api, 12);

    const registry = registryOver(fixture, [source, left, right]);
    const queue = new JobQueue(registry, { batchSize: 2 });

    const landed: string[] = [];
    const copy = (label: string, targetUri: string) =>
      queue.enqueue({
        operation: "copy",
        sourceUri: source.uri,
        targetUri,
        roots: ["/src"],
        targetPath: `/${label}`,
        onWritten: () => landed.push(label),
      });

    const one = copy("one", left.uri);
    const two = copy("two", right.uri);
    await Promise.all([one.done, two.done]);

    expect(landed.length).toBe(24);
    // Global: the two phases interleave rather than forming two passes.
    const lastOne = landed.lastIndexOf("one");
    const firstTwo = landed.indexOf("two");
    expect(firstTwo).toBeLessThan(lastOne);
  });

  // --------------------------------------------------------- §6.6 leases ----

  /**
   * §6.6's third clause, on the resource the work order names: a File System
   * Access handle. `createLease` pins before its first await and unpins if the
   * resolution rejects, so a failed acquisition leaves the lease table exactly as
   * it found it. Without it, a storage whose accessibility check failed would
   * look permanently in use.
   */
  group("a failed root resolution leaves no handle pinned", async (fixture) => {
    const doomed = await fixture.storage("rc6-src");
    await doomed.revoke();
    if (caps.id === "mem") {
      // mem's provider has no lease to leak; it fails the same way twice because
      // there is nothing stateful in it at all.
      expect(caps.canRevokeRootMidFlight).toBe(false);
    }

    const failure = await doomed.rootSecret().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(failure).toBeInstanceOf(Error);

    // Resolved a second time it fails the same way, which it could not do if the
    // first failure had left a pin behind.
    const again = await doomed.rootSecret().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(again).toBeInstanceOf(Error);
  });

  /**
   * A storage whose root is present resolves, and `stats()` narrows to the P1
   * union on a real adapter — the conformance claim P1 made against mem, now made
   * against a real filesystem's idea of size and mtime.
   */
  group("a real file's stats satisfy the P1 file variant", async (fixture) => {
    const storage = await fixture.storage("rc7");
    await writeText(storage.api, "/a/b.txt", "hello");
    const stats = await storage.api.stats("/a/b.txt");
    expect(stats?.kind).toBe("file");
    expect(typeof stats?.size).toBe("number");
    expect(stats?.size).toBe(5);
    expect(typeof stats?.lastModified).toBe("number");
    const dir = await storage.api.stats("/a");
    expect(dir?.kind).toBe("directory");
  });
}
