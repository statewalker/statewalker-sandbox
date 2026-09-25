import { PanelController, PanelModel } from "@fm/app";
import { ChangeNotifier, isUnder, StorageRegistry } from "@fm/core";
import { Commands } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/** C4 — operation-sourced invalidation, prefix fan-out, batched delivery. */

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("C4 · prefix matching", () => {
  it("is directory-aware, not string-naive", () => {
    expect(isUnder("/dir/a.txt", "/dir")).toBe(true);
    expect(isUnder("/dir", "/dir")).toBe(true);
    expect(isUnder("/dir/sub/deep.txt", "/dir")).toBe(true);
    // The trap: /dir2 must not match /dir.
    expect(isUnder("/dir2/a.txt", "/dir")).toBe(false);
    expect(isUnder("/anything", "/")).toBe(true);
  });
});

describe("C4 · batching", () => {
  let notifier: ChangeNotifier;

  beforeEach(() => {
    notifier = new ChangeNotifier();
  });

  it("coalesces a 500-entry job into ONE delivery", async () => {
    let deliveries = 0;
    let events = 0;
    notifier.onChange((batch) => {
      deliveries++;
      events += batch.length;
    });

    for (let i = 0; i < 500; i++) {
      notifier.changed({
        storageUri: "mem://b",
        path: `/dst/f${i}.txt`,
        kind: "created",
        jobId: "j1",
      });
    }
    await tick();

    expect(deliveries).toBe(1);
    expect(events).toBe(500);
  });

  it("delivers a later change as a new batch, not by replaying the first", async () => {
    const batches: number[] = [];
    notifier.onChange((batch) => batches.push(batch.length));
    notifier.changed({ storageUri: "mem://b", path: "/a", kind: "created" });
    await tick();
    notifier.changed({ storageUri: "mem://b", path: "/b", kind: "created" });
    await tick();
    expect(batches).toEqual([1, 1]);
  });

  it("carries the originating job id through to the listener", async () => {
    let seen: string | undefined;
    notifier.onChange((batch) => {
      seen = batch[0].jobId;
    });
    notifier.changed({ storageUri: "mem://b", path: "/x", kind: "created", jobId: "job-7" });
    await tick();
    expect(seen).toBe("job-7");
  });
});

describe("C4 · fan-out across panels", () => {
  let notifier: ChangeNotifier;
  let api: MemFilesApi;
  let panels: { model: PanelModel; controller: PanelController }[];

  const panelAt = (id: string, path: string, storage = "mem://b") => {
    const model = new PanelModel(id, undefined, storage, path);
    const controller = new PanelController(model, api, new Commands(), () => {});
    controller.subscribe(notifier);
    return { model, controller };
  };

  beforeEach(async () => {
    api = new MemFilesApi({ initialFiles: { "/dst/keep.txt": "k", "/other/x.txt": "x" } });
    notifier = new ChangeNotifier();
    panels = [panelAt("p1", "/dst"), panelAt("p2", "/other"), panelAt("p3", "/dst", "mem://z")];
    for (const p of panels) await p.controller.refresh();
  });

  it("re-lists only the panels whose cwd contains the change", async () => {
    await api.write("/dst/new.txt", [new TextEncoder().encode("n")]);
    notifier.changed({ storageUri: "mem://b", path: "/dst/new.txt", kind: "created", jobId: "j1" });
    await tick();
    for (const p of panels) await p.controller.settled();

    expect(panels[0].model.entries.map((e) => e.name).sort()).toEqual(["keep.txt", "new.txt"]);
    expect(panels[1].model.entries.map((e) => e.name)).toEqual(["x.txt"]);
  });

  it("ignores a change on a different storage at the same path", async () => {
    // Counted, not timed: two listings inside one millisecond leave
    // `lastListedAt` unchanged, which would hide the bug entirely.
    let listings = 0;
    panels[2].controller.onListed(() => {
      listings++;
    });
    notifier.changed({ storageUri: "mem://b", path: "/dst/new.txt", kind: "created" });
    await tick();
    await panels[2].controller.settled();
    expect(listings).toBe(0);
  });

  it("re-lists once for a batch of 500 changes in the same directory", async () => {
    let listings = 0;
    panels[0].controller.onListed(() => {
      listings++;
    });
    for (let i = 0; i < 500; i++) {
      notifier.changed({
        storageUri: "mem://b",
        path: `/dst/f${i}.txt`,
        kind: "created",
        jobId: "j1",
      });
    }
    await tick();
    await panels[0].controller.settled();
    expect(listings).toBe(1);
  });

  it("marks rows by originating job while the change is in flight", async () => {
    // The mark is transient by design — it exists only until the listing that
    // reflects it arrives, which against mem storage is the same tick. So the
    // assertion observes the notification rather than racing the refresh.
    const snapshots: Record<string, { jobId?: string; kind: string }>[] = [];
    panels[0].model.onUpdate(() => snapshots.push(panels[0].model.marks));

    notifier.changed({
      storageUri: "mem://b",
      path: "/dst/keep.txt",
      kind: "pending-delete",
      jobId: "j9",
    });
    await tick();
    await panels[0].controller.settled();

    expect(snapshots.some((m) => m["/dst/keep.txt"]?.jobId === "j9")).toBe(true);
    expect(snapshots.some((m) => m["/dst/keep.txt"]?.kind === "pending-delete")).toBe(true);
  });

  it("clears marks once the listing that reflects them arrives", async () => {
    notifier.changed({
      storageUri: "mem://b",
      path: "/dst/keep.txt",
      kind: "pending-delete",
      jobId: "j9",
    });
    await tick();
    await panels[0].controller.settled();
    expect(panels[0].model.marks).toEqual({});
  });

  it("stops re-listing after the panel unsubscribes", async () => {
    let listings = 0;
    panels[0].controller.onListed(() => {
      listings++;
    });
    panels[0].controller.dispose();
    notifier.changed({ storageUri: "mem://b", path: "/dst/x", kind: "created" });
    await tick();
    await panels[0].controller.settled();
    expect(listings).toBe(0);
  });
});

describe("C4 · polling is opt-in and observer-bound", () => {
  const registry = (pollMs?: number) =>
    new StorageRegistry(
      [{ uri: "s3://b", adapter: "mem", options: {}, ...(pollMs ? { pollMs } : {}) }],
      { mem: () => new MemFilesApi() },
      {
        async get() {
          return undefined;
        },
      },
    );

  it("does not poll by default", () => {
    const notifier = new ChangeNotifier(registry());
    notifier.observe("s3://b", "/dir", () => {});
    expect(notifier.isPolling("s3://b")).toBe(false);
    notifier.dispose();
  });

  it("polls only while a directory is observed", () => {
    const notifier = new ChangeNotifier(registry(50));
    const stop = notifier.observe("s3://b", "/dir", () => {});
    expect(notifier.isPolling("s3://b")).toBe(true);
    expect(notifier.observedPaths("s3://b")).toEqual(["/dir"]);
    stop();
    expect(notifier.isPolling("s3://b")).toBe(false);
    notifier.dispose();
  });

  it("keeps polling while any observer remains", () => {
    const notifier = new ChangeNotifier(registry(50));
    const stopA = notifier.observe("s3://b", "/a", () => {});
    notifier.observe("s3://b", "/b", () => {});
    stopA();
    expect(notifier.isPolling("s3://b")).toBe(true);
    notifier.dispose();
  });

  it("reports that no adapter can watch — the hook exists, nothing implements it", () => {
    expect(registry().canWatch("s3://b")).toBe(false);
  });
});
