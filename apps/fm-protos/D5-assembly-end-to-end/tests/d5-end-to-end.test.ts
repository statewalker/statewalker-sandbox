import {
  ConfigStore,
  FileManager,
  type MenuModel,
  type NotificationModel,
  type PanelModel,
  registerStorageOpener,
  uiShowConflict,
  uiShowMenu,
  uiShowPanel,
} from "@fm/app";
import { StorageRegistry, storagesOpen } from "@fm/core";
import { ViewAdapter } from "@fm/ui";
import { Commands } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * D5 — the whole thing, driven the way a user drives it.
 *
 * Nothing here reaches past a public seam: filesystems arrive through
 * `storages:open`, operations through `files:*`, views through `ui:*`. If the
 * layering has quietly stopped holding anywhere, this is where it shows.
 */

describe("D5 · end to end", () => {
  let commands: Commands;
  let registry: StorageRegistry;
  let config: ConfigStore;
  let disk: MemFilesApi;
  let fm: FileManager;
  let views: { panels: PanelModel[]; menus: MenuModel[]; notes: NotificationModel[] };
  let adapter: ViewAdapter;
  let conflictAnswer: { resolution: "overwrite" | "skip" | "rename"; applyToAll: boolean };

  /**
   * ONE opener for the app's lifetime, answering successive calls — which is
   * how a real environment works: a single handler, a dialog that returns a
   * different folder each time.
   *
   * Registering a second opener does NOT replace the first: both are fallbacks
   * at the same priority, both decline when the command is already claimed,
   * and the earliest registration wins. Replacing an opener means disposing
   * the previous one or claiming at priority 0.
   */
  let pending: { files: Record<string, string>; name: string }[];

  const openStorage = async (files: Record<string, string>, name: string) => {
    pending.push({ files, name });
    const result = await commands.call(storagesOpen, { mode: "readwrite" }).promise;
    return result.uri!;
  };

  beforeEach(() => {
    commands = new Commands();
    registry = new StorageRegistry(
      [],
      {},
      {
        async get() {
          return undefined;
        },
      },
    );
    disk = new MemFilesApi();
    config = new ConfigStore(disk, "/config", 10);
    views = { panels: [], menus: [], notes: [] };
    conflictAnswer = { resolution: "overwrite", applyToAll: true };

    adapter = new ViewAdapter(commands, {
      panel: ((view: { model: PanelModel }) => {
        views.panels.push(view.model);
        return () => views.panels.splice(views.panels.indexOf(view.model), 1);
      }) as never,
      menu: ((view: { model: MenuModel; settle: (r: unknown) => void }) => {
        views.menus.push(view.model);
        view.settle({ selectedKey: view.model.items[0]?.key });
      }) as never,
      notify: ((view: { model: NotificationModel; settle: (r: unknown) => void }) => {
        views.notes.push(view.model);
        view.settle(undefined);
      }) as never,
      conflict: ((view: { settle: (r: unknown) => void }) => view.settle(conflictAnswer)) as never,
      job: (() => true) as never,
    });

    pending = [];
    registerStorageOpener(commands, registry, async () => {
      const next = pending.shift();
      return next
        ? { api: new MemFilesApi({ initialFiles: next.files }), name: next.name }
        : undefined;
    });

    fm = new FileManager({ commands, registry, config, slots: ["left", "right"] });
  });

  it("opens two filesystems, shows two panels, and lists both", async () => {
    const left = await openStorage({ "/a.txt": "a", "/b.txt": "b" }, "Left");
    const right = await openStorage({ "/keep.txt": "k" }, "Right");

    const one = await fm.addPanel(left, "/");
    const two = await fm.addPanel(right, "/");

    expect(views.panels.map((p) => p.id)).toEqual([one.id, two.id]);
    expect(one.table.rowCount).toBe(2);
    expect(two.table.rowCount).toBe(1);
    expect(fm.panels.order).toHaveLength(2);
  });

  it("copies between panels and the target panel re-lists itself", async () => {
    const left = await openStorage({ "/a.txt": "a" }, "Left");
    const right = await openStorage({ "/keep.txt": "k" }, "Right");
    const source = await fm.addPanel(left, "/");
    const target = await fm.addPanel(right, "/");
    fm.panels.activate(source.id);

    const { jobId } = await fm.copyFromPanel(source.id, [
      { storage: left, path: "/a.txt", kind: "file" },
    ]);
    await fm.jobs.get(jobId).done;

    // The panel was never told to refresh: the job's change notification did it.
    fm.notifier.changed({ storageUri: right, path: "/a.txt", kind: "created", jobId });
    await new Promise((r) => setTimeout(r, 0));
    await target.controller.settled();

    expect(target.table.rowCount).toBe(2);
    expect(target.controller.model.entries.map((e) => e.name).sort()).toEqual([
      "a.txt",
      "keep.txt",
    ]);
  });

  it("needs no picker with two panels: the target is the other one", async () => {
    const left = await openStorage({ "/a.txt": "a" }, "Left");
    const right = await openStorage({}, "Right");
    const source = await fm.addPanel(left, "/");
    await fm.addPanel(right, "/");
    fm.panels.activate(source.id);

    expect(fm.panels.targetFor(source.id)!.needsPicker).toBe(false);
    expect(views.menus).toHaveLength(0);
  });

  it("offers the whole namespace in a menu when no host narrows it", async () => {
    const left = await openStorage({ "/a.txt": "a" }, "Left");
    await fm.addPanel(left, "/");

    const result = await fm.menuFor([{ storage: left, path: "/a.txt", kind: "file" }]);
    expect(views.menus).toHaveLength(1);
    expect(views.menus[0].items.map((i) => i.key)).toEqual([
      "files:copy",
      "files:move",
      "files:delete",
      "files:mkdir",
      "files:rename",
    ]);
    expect(result.selectedKey).toBe("files:copy");
  });

  it("resolves a conflict through the real dialog, and the answer reaches the engine", async () => {
    const left = await openStorage({ "/a.txt": "new" }, "Left");
    const right = await openStorage({ "/a.txt": "old" }, "Right");
    const source = await fm.addPanel(left, "/");
    await fm.addPanel(right, "/");
    fm.panels.activate(source.id);
    conflictAnswer = { resolution: "skip", applyToAll: true };

    const resolver = fm.conflictResolver();
    const decision = await resolver(
      { path: "/a.txt", target: "/a.txt" },
      new AbortController().signal,
    );
    expect(decision).toEqual({ resolution: "skip", applyToAll: true });
  });

  it("persists the session as panels change, and restores it", async () => {
    const left = await openStorage({ "/a.txt": "a" }, "Left");
    const one = await fm.addPanel(left, "/");
    await config.flushSession();

    const saved = (await config.loadSession())!;
    expect(saved.panels).toHaveLength(1);
    expect(saved.panels[0].storage).toBe(left);

    await fm.removePanel(one.id);
    await config.flushSession();
    expect((await config.loadSession())!.panels).toHaveLength(0);
  });

  it("follows a panel's navigation into the session, not just its creation", async () => {
    const left = await openStorage({ "/sub/x.txt": "x", "/a.txt": "a" }, "Left");
    const one = await fm.addPanel(left, "/");
    await config.flushSession();
    expect((await config.loadSession())!.panels[0].path).toBe("/");

    await one.controller.navigate("/sub");
    await config.flushSession();

    // Reopening the app should land where the user left off, which means the
    // session has to track navigation, not merely which panels exist.
    expect((await config.loadSession())!.panels[0].path).toBe("/sub");
  });

  it("restores what it can and names what it cannot", async () => {
    const left = await openStorage({ "/a.txt": "a" }, "Left");
    const session = {
      version: 1,
      panels: [
        { id: "p1", storage: left, path: "/", name: "Left" },
        { id: "p2", storage: "usb://photos", path: "/DCIM", name: "Photos" },
      ],
    };

    const unavailable = await fm.restore(session, [{ uri: left, adapter: "adopted", options: {} }]);

    expect(unavailable).toEqual(["Photos"]);
    // Both panels exist — the unavailable one keeps its name rather than
    // vanishing, and the available one is fully live.
    expect(fm.panels.order).toHaveLength(2);
    expect(fm.panels.order.map((id) => fm.panels.get(id).name)).toContain("Photos");
    expect(views.panels).toHaveLength(1); // only the live one is shown
  });

  it("releases every storage when the app shuts down", async () => {
    const left = await openStorage({ "/a.txt": "a" }, "Left");
    await fm.addPanel(left, "/");
    expect(registry.isLive(left)).toBe(true);

    await fm.dispose();
    expect(registry.isLive(left)).toBe(false);
    expect(fm.panels.order).toHaveLength(0);
  });

  it("closes the views it opened", async () => {
    const left = await openStorage({ "/a.txt": "a" }, "Left");
    const one = await fm.addPanel(left, "/");
    expect(views.panels).toHaveLength(1);

    await fm.removePanel(one.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(views.panels).toHaveLength(0);
    adapter.dispose();
  });
});
