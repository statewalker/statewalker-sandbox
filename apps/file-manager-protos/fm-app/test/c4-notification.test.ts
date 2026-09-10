import {
  ChangeNotifier,
  expectEdgeCounter,
  expectNoSelfWake,
  expectReplacedNotMutated,
  type Invalidation,
  PanelController,
  PanelModel,
  uiShowPanel,
} from "@fm/app";
import { Commands } from "@statewalker/shared-commands";
import type { FileInfo, FilesApi, ListOptions } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * C4 — change notification.
 *
 * Three tiers, of which only the first ships: operations are authoritative and
 * always available and carry the originating job id; polling sits behind a
 * per-storage `pollMs` defaulting to OFF; the adapter watcher hook is left
 * unimplemented. There is no `watch()` anywhere in `webrun-files`, so that is
 * not a limitation to design around later — it is the permanent shape.
 *
 * Per §6.5 every assertion here is on counts and per-row facts. Parallel batches
 * legitimately interleave, so notification order is not asserted anywhere.
 */

/** Counts listings, so a coalesced refresh is measured rather than assumed. */
class CountingFilesApi extends MemFilesApi {
  readonly listed: string[] = [];
  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    this.listed.push(path);
    yield* super.list(path, options);
  }
}

interface Panel {
  model: PanelModel;
  controller: PanelController;
  api: CountingFilesApi;
  reactions: () => number;
}

async function panel(
  api: CountingFilesApi,
  path: string,
  storage = "mem://a",
  commands = new Commands(),
): Promise<Panel> {
  commands.listen(uiShowPanel, () => true);
  const model = new PanelModel("p1", "left", storage, path);
  let reactions = 0;
  const controller = new PanelController(model, api, commands, () => {
    reactions++;
  });
  await controller.activate();
  return { model, controller, api, reactions: () => reactions };
}

const seeded = (files: Record<string, string>) => new CountingFilesApi({ initialFiles: files });

const settle = async (notifier: ChangeNotifier, ...panels: Panel[]) => {
  await notifier.settled();
  for (const p of panels) await p.controller.settled();
  await new Promise((r) => setTimeout(r, 2));
  for (const p of panels) await p.controller.settled();
};

const change = (over: Partial<Invalidation> = {}): Invalidation => ({
  storage: "mem://a",
  path: "/dst/a.txt",
  kind: "created",
  ...over,
});

describe("C4 · operations are the authoritative producer", () => {
  let notifier: ChangeNotifier;

  beforeEach(() => {
    notifier = new ChangeNotifier();
  });

  it("updates a panel showing the directory, without anyone telling it to", async () => {
    const api = seeded({ "/dst/keep.txt": "k" });
    const p = await panel(api, "/dst");
    notifier.observe(p.controller);
    expect(p.model.entries.map((e) => e.name)).toEqual(["keep.txt"]);

    await api.write("/dst/new.txt", [new TextEncoder().encode("n")]);
    notifier.invalidate(change({ path: "/dst/new.txt", jobId: "job-1" }));
    await settle(notifier, p);

    expect(p.model.entries.map((e) => e.name).sort()).toEqual(["keep.txt", "new.txt"]);
  });

  it("carries the originating job id through to the observer", async () => {
    const seen: Invalidation[] = [];
    notifier.observe({
      storage: "mem://a",
      path: "/dst",
      applyChanges: (changes) => seen.push(...changes),
    });

    notifier.invalidate(change({ jobId: "job-7" }));
    await notifier.settled();

    // Nothing consumes it beyond per-row marking in v1. It costs a field, and
    // without it the optimistic-rows version later needs the engine changed
    // rather than just the panel.
    expect(seen.map((c) => c.jobId)).toEqual(["job-7"]);
  });

  it("ignores a change on another storage", async () => {
    const api = seeded({ "/dst/keep.txt": "k" });
    const p = await panel(api, "/dst");
    notifier.observe(p.controller);
    const before = api.listed.length;

    notifier.invalidate(change({ storage: "mem://elsewhere" }));
    await settle(notifier, p);

    expect(api.listed.length).toBe(before);
  });
});

describe("C4 · the prefix fan-out", () => {
  let notifier: ChangeNotifier;

  const fanout = async (cwd: string, path: string): Promise<boolean> => {
    let applied = false;
    notifier.observe({
      storage: "mem://a",
      path: cwd,
      applyChanges: () => {
        applied = true;
      },
    });
    notifier.invalidate(change({ path }));
    await notifier.settled();
    return applied;
  };

  beforeEach(() => {
    notifier = new ChangeNotifier();
  });

  it("matches a change inside the directory", async () => {
    expect(await fanout("/dst", "/dst/a.txt")).toBe(true);
  });

  it("matches a change deeper in the tree, which may add a subdirectory row", async () => {
    expect(await fanout("/dst", "/dst/sub/deep/a.txt")).toBe(true);
  });

  it("matches a change at the directory itself", async () => {
    expect(await fanout("/dst", "/dst")).toBe(true);
  });

  it("matches everything when the panel is at the root", async () => {
    expect(await fanout("/", "/anywhere/at/all.txt")).toBe(true);
  });

  it("does NOT match a sibling whose name merely starts with the same text", async () => {
    // `"/dst-old/a.txt".startsWith("/dst")` is true and wrong: the panel showing
    // /dst would re-list on every change in an unrelated directory.
    expect(await fanout("/dst", "/dst-old/a.txt")).toBe(false);
  });

  it("does NOT match the parent of the directory", async () => {
    expect(await fanout("/dst/sub", "/dst/other.txt")).toBe(false);
  });
});

describe("C4 · batching (§6.5)", () => {
  let notifier: ChangeNotifier;
  let api: CountingFilesApi;
  let p: Panel;

  beforeEach(async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 500; i++) files[`/src/f${String(i).padStart(3, "0")}.txt`] = "x";
    api = seeded(files);
    p = await panel(api, "/src");
    notifier = new ChangeNotifier();
    notifier.observe(p.controller);
  });

  it("produces a bounded notification count for a 500-entry batch, not 500", async () => {
    let notifies = 0;
    p.model.onUpdate(() => {
      notifies++;
    });

    for (let i = 0; i < 500; i++) {
      notifier.invalidate(
        change({
          path: `/src/f${String(i).padStart(3, "0")}.txt`,
          kind: "removed",
          jobId: "job-1",
        }),
      );
    }
    await settle(notifier, p);

    // `notify()` is synchronous and undifferentiated, so a job completing 500
    // entries must not call it 500 times.
    expect(notifies).toBeGreaterThan(0);
    expect(notifies).toBeLessThanOrEqual(10);
  });

  it("re-lists once for the whole batch, not once per entry", async () => {
    const before = api.listed.length;
    for (let i = 0; i < 500; i++) {
      notifier.invalidate(
        change({
          path: `/src/f${String(i).padStart(3, "0")}.txt`,
          kind: "removed",
          jobId: "job-1",
        }),
      );
    }
    await settle(notifier, p);

    expect(api.listed.length - before).toBe(1);
  });

  it("marks every affected row — asserted per item, never by order", async () => {
    for (let i = 0; i < 500; i++) {
      notifier.invalidate(
        change({
          path: `/src/f${String(i).padStart(3, "0")}.txt`,
          kind: "removed",
          jobId: "job-1",
        }),
      );
    }
    await notifier.settled();

    // Per-item invariants under concurrency, plus one global count.
    for (let i = 0; i < 500; i += 97) {
      const path = `/src/f${String(i).padStart(3, "0")}.txt`;
      expect(p.model.marks[path], path).toEqual({ jobId: "job-1", kind: "pending-delete" });
    }
    expect(Object.keys(p.model.marks).length).toBe(500);
  });
});

describe("C4 · per-row marking, the weak version v1 ships", () => {
  let notifier: ChangeNotifier;
  let api: CountingFilesApi;
  let p: Panel;

  beforeEach(async () => {
    api = seeded({ "/src/a.txt": "a", "/src/b.txt": "b" });
    p = await panel(api, "/src");
    notifier = new ChangeNotifier();
    notifier.observe(p.controller);
  });

  it("marks an existing row pending-delete without removing it", async () => {
    notifier.invalidate(change({ path: "/src/a.txt", kind: "removed", jobId: "job-3" }));
    await notifier.settled();

    // This is the genuinely confusing case: a move that appears to do nothing
    // until it finishes.
    expect(p.model.marks["/src/a.txt"]).toEqual({ jobId: "job-3", kind: "pending-delete" });
    expect(p.model.rows.map((r) => r.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("synthesises no row for a path it has never listed", async () => {
    // Both kinds, because only `removed` reaches the marking guard at all — a
    // test that used `created` alone would never exercise it.
    notifier.invalidate(change({ path: "/src/ghost.txt", kind: "created", jobId: "job-3" }));
    notifier.invalidate(change({ path: "/src/phantom.txt", kind: "removed", jobId: "job-3" }));
    await notifier.settled();

    // Full optimistic rows introduce a second source of truth in `entries`, and
    // a phantom that never settles because a job failed is a stale lie.
    expect(p.model.marks["/src/ghost.txt"]).toBeUndefined();
    expect(p.model.marks["/src/phantom.txt"]).toBeUndefined();
    expect(p.model.marks).toEqual({});
    expect(p.model.rows.map((r) => r.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("marks nothing when the change names no job", async () => {
    notifier.invalidate(change({ path: "/src/a.txt", kind: "removed" }));
    await notifier.settled();
    expect(p.model.marks).toEqual({});
  });

  it("marks nothing for a change that is not a removal", async () => {
    notifier.invalidate(change({ path: "/src/a.txt", kind: "updated", jobId: "job-3" }));
    await notifier.settled();
    expect(p.model.marks).toEqual({});
  });

  it("clears the marks once a listing has settled the truth", async () => {
    notifier.invalidate(change({ path: "/src/a.txt", kind: "removed", jobId: "job-3" }));
    await notifier.settled();
    expect(Object.keys(p.model.marks)).toEqual(["/src/a.txt"]);

    await settle(notifier, p);

    // A decoration derived from job state can be wrong without corrupting
    // anything, so the listing is what settles it.
    expect(p.model.marks).toEqual({});
  });
});

describe("C4 · polling is per storage and defaults to off", () => {
  it("never lists anything when no pollMs is declared", async () => {
    const api = seeded({ "/src/a.txt": "a" });
    const p = await panel(api, "/src");
    const notifier = new ChangeNotifier();
    notifier.observe(p.controller);
    const before = api.listed.length;

    await new Promise((r) => setTimeout(r, 40));
    await settle(notifier, p);

    // `list()` on a remote storage is a real cost, and "F2 refreshes" is an
    // accepted commander idiom.
    expect(api.listed.length).toBe(before);
    notifier.dispose();
  });

  it("re-lists an observed directory when the storage declares a pollMs", async () => {
    const api = seeded({ "/src/a.txt": "a" });
    const p = await panel(api, "/src");
    const notifier = new ChangeNotifier({ pollMs: { "mem://a": 5 } });
    notifier.observe(p.controller);
    const before = api.listed.length;

    await new Promise((r) => setTimeout(r, 40));
    await settle(notifier, p);

    expect(api.listed.length).toBeGreaterThan(before);
    // A poll is not a job. It has no job id to re-pair with and nothing to
    // decorate, so it must never leave a row looking pending.
    expect(p.model.marks).toEqual({});
    notifier.dispose();
  });

  it("polls only the storages that declared it", async () => {
    const polled = seeded({ "/src/a.txt": "a" });
    const quiet = seeded({ "/src/b.txt": "b" });
    const a = await panel(polled, "/src", "mem://a");
    const b = await panel(quiet, "/src", "mem://b");
    const notifier = new ChangeNotifier({ pollMs: { "mem://a": 5 } });
    notifier.observe(a.controller);
    notifier.observe(b.controller);
    const beforeA = polled.listed.length;
    const beforeB = quiet.listed.length;

    await new Promise((r) => setTimeout(r, 40));
    await settle(notifier, a, b);

    expect(polled.listed.length).toBeGreaterThan(beforeA);
    expect(quiet.listed.length).toBe(beforeB);
    notifier.dispose();
  });

  it("polls only while a directory has a live observer", async () => {
    const api = seeded({ "/src/a.txt": "a" });
    const p = await panel(api, "/src");
    const notifier = new ChangeNotifier({ pollMs: { "mem://a": 5 } });
    const unobserve = notifier.observe(p.controller);

    await new Promise((r) => setTimeout(r, 20));
    await settle(notifier, p);
    expect(api.listed.length).toBeGreaterThan(1);

    unobserve();
    const afterUnobserve = api.listed.length;
    await new Promise((r) => setTimeout(r, 40));
    await settle(notifier, p);

    expect(api.listed.length).toBe(afterUnobserve);
    notifier.dispose();
  });

  it("pins the poll timer synchronously, before any await (§6.6)", () => {
    const notifier = new ChangeNotifier({ pollMs: { "mem://a": 5 } });
    expect(notifier.polling()).toEqual([]);

    // Bookkeeping is not I/O and must not inherit its latency: a timer is a
    // lifetime-bound resource, pinned synchronously and released on the last
    // observer going away.
    const unobserve = notifier.observe({
      storage: "mem://a",
      path: "/src",
      applyChanges: () => {},
    });
    expect(notifier.polling()).toEqual(["mem://a"]);

    unobserve();
    expect(notifier.polling()).toEqual([]);
    notifier.dispose();
  });

  it("keeps polling while any observer on the storage remains", () => {
    const notifier = new ChangeNotifier({ pollMs: { "mem://a": 5 } });
    const one = notifier.observe({ storage: "mem://a", path: "/x", applyChanges: () => {} });
    const two = notifier.observe({ storage: "mem://a", path: "/y", applyChanges: () => {} });

    one();
    expect(notifier.polling()).toEqual(["mem://a"]);
    two();
    expect(notifier.polling()).toEqual([]);
    notifier.dispose();
  });

  it("is idempotent about unobserving, so a double release cannot stop a live poll", () => {
    const notifier = new ChangeNotifier({ pollMs: { "mem://a": 5 } });
    const one = notifier.observe({ storage: "mem://a", path: "/x", applyChanges: () => {} });
    const two = notifier.observe({ storage: "mem://a", path: "/y", applyChanges: () => {} });

    one();
    one();
    // The P2 rule, restated for observers: an unknown release is a no-op, never
    // a decrement, or one side's double release disposes what the other holds.
    expect(notifier.polling()).toEqual(["mem://a"]);
    two();
    expect(notifier.polling()).toEqual([]);
    notifier.dispose();
  });
});

describe("C4 · a change raised from inside a delivery is not lost", () => {
  it("delivers what an observer queues while it is being notified", async () => {
    // This is the republishing shape a later cross-tab producer needs: it hears
    // an incoming change and publishes it into the same path. Dropping it would
    // make that stage impossible to add without changing the notifier.
    const notifier = new ChangeNotifier();
    const seen: string[] = [];
    let republished = false;

    notifier.observe({
      storage: "mem://a",
      path: "/src",
      applyChanges: (changes) => {
        for (const c of changes) seen.push(c.path);
        if (republished) return;
        republished = true;
        notifier.invalidate(change({ path: "/src/echo.txt" }));
      },
    });

    notifier.invalidate(change({ path: "/src/a.txt" }));
    await notifier.settled();

    expect(seen).toContain("/src/a.txt");
    expect(seen).toContain("/src/echo.txt");
    notifier.dispose();
  });
});

describe("C4 · the adapter watcher tier is deliberately absent", () => {
  it("has no watch() to call on a FilesApi", () => {
    const api: FilesApi = new MemFilesApi();
    // Not a limitation to be designed around later: there is no watcher anywhere
    // in webrun-files, which is why operations are the primary producer and
    // polling is the only fallback.
    expect("watch" in api).toBe(false);
    expect((api as unknown as Record<string, unknown>).watch).toBeUndefined();
  });

  it("offers no watcher tier on the notifier either", () => {
    const notifier = new ChangeNotifier();
    expect((notifier as unknown as Record<string, unknown>).watch).toBeUndefined();
  });
});

describe("C4 · model discipline, all three kit helpers (§6.2)", () => {
  let notifier: ChangeNotifier;
  let p: Panel;

  beforeEach(async () => {
    p = await panel(seeded({ "/src/a.txt": "a", "/src/b.txt": "b" }), "/src");
    notifier = new ChangeNotifier();
    notifier.observe(p.controller);
  });

  it("replaces `marks` rather than mutating them", async () => {
    await expectReplacedNotMutated(
      p.model,
      () => p.model.marks,
      async () => {
        notifier.invalidate(change({ path: "/src/a.txt", kind: "removed", jobId: "job-1" }));
        await notifier.settled();
      },
    );
  });

  it("cannot be woken by a change the controller applied itself", async () => {
    await expectNoSelfWake(p.model.input, p.model, p.reactions, async () => {
      notifier.invalidate(change({ path: "/src/a.txt", kind: "removed", jobId: "job-1" }));
      await notifier.settled();
    });
  });

  it("still holds refresh as an edge counter, which is the user's answer to staleness", () => {
    let handled = 0;
    let observed = 0;
    p.model.input.onUpdate(() => {
      observed += p.model.input.refreshCount - handled;
      handled = p.model.input.refreshCount;
    });
    expectEdgeCounter(p.model.input as never, "refreshCount", () => observed);
  });
});

describe("C4 · cleanup precedes settlement (§6.4)", () => {
  it("unobserves before ui:show-panel settles, so nothing pushes into a detached model", async () => {
    const order: string[] = [];
    const commands = new Commands();
    let viewCmd: { settled: boolean } | undefined;
    commands.listen(uiShowPanel, (cmd) => {
      viewCmd = cmd;
      cmd.promise.then(
        () => order.push("settled"),
        () => order.push("settled"),
      );
      return true;
    });

    const notifier = new ChangeNotifier();
    const model = new PanelModel("p1", "left", "mem://a", "/src");
    const api = seeded({ "/src/a.txt": "a" });
    let observedWhenReleased: boolean | undefined;
    const controller = new PanelController(model, api, commands, () => {}, {
      release: () => {
        observedWhenReleased = viewCmd?.settled ?? false;
        order.push("unobserved");
      },
    });
    await controller.activate();
    const unobserve = notifier.observe(controller);
    void unobserve;

    controller.dispose();
    await new Promise((r) => setTimeout(r, 2));

    expect(order).toEqual(["unobserved", "settled"]);
    expect(observedWhenReleased).toBe(false);
    expect(viewCmd?.settled).toBe(true);
    notifier.dispose();
  });

  it("a change arriving after dispose touches nothing", async () => {
    const api = seeded({ "/src/a.txt": "a" });
    const p = await panel(api, "/src");
    const notifier = new ChangeNotifier();
    const unobserve = notifier.observe(p.controller);

    unobserve();
    p.controller.dispose();
    const before = api.listed.length;

    notifier.invalidate(change({ path: "/src/a.txt", kind: "created", jobId: "job-1" }));
    await settle(notifier, p);

    expect(api.listed.length).toBe(before);
    notifier.dispose();
  });
});

describe("C4 · end to end, through the real bus and the real engine", () => {
  const app = async (files: Record<string, string>, left: CountingFilesApi) => {
    const { bootstrap, uiShowJob } = await import("@fm/app");
    const commands = new Commands();
    commands.listen(uiShowPanel, () => true);
    commands.listen(uiShowJob, () => true);
    const right = seeded(files);
    const instance = await bootstrap({
      commands,
      storages: { left, right },
      panels: [
        { id: "p1", slot: "left", storage: "left", path: "/src" },
        { id: "p2", slot: "right", storage: "right", path: "/dst" },
      ],
    });
    return { commands, instance, right };
  };

  it("updates the panel showing the target, with nobody telling it to", async () => {
    const left = seeded({ "/src/a.txt": "a" });
    const { commands, instance, right } = await app({ "/dst/keep.txt": "k" }, left);
    const { filesCopy } = await import("@fm/app");

    const { jobId } = await commands.call(filesCopy, {
      files: [{ storage: "left", path: "/src/a.txt", kind: "file" as const }],
      target: { storage: "right", path: "/dst" },
    }).promise;
    await instance.jobs.get(jobId).done;
    await instance.settled();

    expect(
      instance.panels
        .get("p2")
        .entries.map((e) => e.name)
        .sort(),
    ).toEqual(["a.txt", "keep.txt"]);
    expect(right.listed.length).toBeGreaterThan(1);
    instance.dispose();
  });

  it("carries the engine's own job id on the invalidation it produces", async () => {
    const left = seeded({ "/src/a.txt": "a" });
    const { commands, instance } = await app({ "/dst/keep.txt": "k" }, left);
    const { filesCopy } = await import("@fm/app");

    const seen: Invalidation[] = [];
    instance.changes.observe({
      storage: "right",
      path: "/dst",
      applyChanges: (changes) => seen.push(...changes),
    });

    const { jobId } = await commands.call(filesCopy, {
      files: [{ storage: "left", path: "/src/a.txt", kind: "file" as const }],
      target: { storage: "right", path: "/dst" },
    }).promise;
    await instance.jobs.get(jobId).done;
    await instance.settled();

    expect(seen.length).toBeGreaterThan(0);
    for (const change of seen) {
      expect(change.jobId, change.path).toBe(jobId);
      expect(change.kind).toBe("created");
      expect(change.storage).toBe("right");
    }
    instance.dispose();
  });

  it("keeps the notification count bounded for a 500-file copy", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 500; i++) files[`/src/f${String(i).padStart(3, "0")}.txt`] = "x";
    const left = seeded(files);
    const { commands, instance, right } = await app({ "/dst/keep.txt": "k" }, left);
    const { filesCopy } = await import("@fm/app");

    let notifies = 0;
    instance.panels.get("p2").onUpdate(() => {
      notifies++;
    });
    const listedBefore = right.listed.length;

    const { jobId } = await commands.call(filesCopy, {
      files: [{ storage: "left", path: "/src", kind: "directory" as const }],
      target: { storage: "right", path: "/dst" },
    }).promise;
    await instance.jobs.get(jobId).done;
    await instance.settled();

    expect(instance.panels.get("p2").entries.length).toBe(501);

    // The bound the records state is per BATCH, not per entry: the engine's
    // batch is the checkpoint barrier and the notification barrier both. At the
    // default batchSize of 8 a 500-file copy is 63 batches, so the target panel
    // re-lists ~63 times and notifies ~158 — bounded by batches, and nowhere
    // near the 500 that calling notify() per entry would produce.
    const listings = right.listed.length - listedBefore;
    expect(listings).toBeLessThanOrEqual(Math.ceil(500 / 8) + 4);
    expect(listings).toBeGreaterThan(1); // it updates DURING the copy, not only at the end
    expect(notifies).toBeLessThan(500);
    instance.dispose();
  });

  it("stops notifying a panel that has been removed", async () => {
    const left = seeded({ "/src/a.txt": "a", "/src/b.txt": "b" });
    const { commands, instance, right } = await app({ "/dst/keep.txt": "k" }, left);
    const { filesCopy } = await import("@fm/app");

    await instance.panels.remove("p2");
    const listedBefore = right.listed.length;

    const { jobId } = await commands.call(filesCopy, {
      files: [{ storage: "left", path: "/src/a.txt", kind: "file" as const }],
      target: { storage: "right", path: "/dst" },
    }).promise;
    await instance.jobs.get(jobId).done;
    await instance.settled();

    // Panel removal released the observer registration, so nothing pushes into
    // a detached model.
    expect(right.listed.length).toBe(listedBefore);
    instance.dispose();
  });
});
