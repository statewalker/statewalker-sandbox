import { type App, bootstrap, filesCopy, panelsNavigate, uiShowJob, uiShowPanel } from "@fm/app";
import { onChange } from "@statewalker/shared-baseclass";
import { CommandError, Commands } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeViewLayer } from "./support/fake-view-layer.js";

/**
 * P0 — the architecture skeleton.
 *
 * Every assertion here is about STRUCTURE, not features. The scenario is
 * deliberately trivial; what is under test is that the mechanisms the rest of
 * the design depends on exist in their real shape.
 */
describe("P0 · architecture skeleton", () => {
  let left: MemFilesApi;
  let right: MemFilesApi;
  let commands: Commands;
  let views: FakeViewLayer;
  let app: App;

  beforeEach(async () => {
    left = new MemFilesApi({
      initialFiles: { "/src/a.txt": "aaa", "/src/b.txt": "bbb", "/src/c.txt": "ccc" },
    });
    right = new MemFilesApi({ initialFiles: { "/dst/keep.txt": "keep" } });
    commands = new Commands();
    views = new FakeViewLayer(commands);

    // Bootstrap order: bus → view handlers → controllers.
    views.register();
    app = await bootstrap({
      commands,
      storages: { left, right },
      panels: [
        { id: "p1", slot: "left", storage: "left", path: "/src" },
        { id: "p2", slot: "right", storage: "right", path: "/dst" },
      ],
    });
  });

  describe("controllers order views into existence via commands", () => {
    it("renders one view per panel, from ui:show-panel, with the model as payload", () => {
      expect(views.openPanels.map((v) => v.model.id)).toEqual(["p1", "p2"]);
      expect(views.openPanels[0].model.path).toBe("/src");
    });

    it("removes the view when the command settles — from the view side", async () => {
      await views.openPanels[0].settleFromUser();
      expect(views.openPanels.map((v) => v.model.id)).toEqual(["p2"]);
    });

    it("removes the view when the command settles — from the controller side", async () => {
      await app.panels.remove("p2");
      expect(views.openPanels.map((v) => v.model.id)).toEqual(["p1"]);
    });
  });

  describe("controller ⇄ model ⇄ view, both directions", () => {
    it("controller writes stable data the view reads", () => {
      const panel = app.panels.get("p1");
      expect(panel.entries.map((e) => e.name).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    });

    it("view writes only into input, and the controller reacts to it", async () => {
      const panel = app.panels.get("p1");
      panel.input.requestedPath = "/";
      panel.input.navigateCount++;
      panel.input.notify();
      await app.settled();

      expect(panel.path).toBe("/");
      expect(panel.entries.map((e) => e.name)).toEqual(["src"]);
    });

    it("level fields holding arrays are replaced, never mutated in place", async () => {
      const panel = app.panels.get("p1");
      let fired = 0;
      onChange(
        panel.onUpdate,
        () => fired++,
        () => panel.entries,
      );

      panel.input.requestedPath = "/";
      panel.input.navigateCount++;
      panel.input.notify();
      await app.settled();

      // `entries.push(...)` + notify() is invisible to a watcher of
      // `() => model.entries`, so an in-place mutation must not pass here.
      expect(fired).toBeGreaterThan(0);
    });

    it("a controller's own writes to the outer model cannot wake it", async () => {
      const panel = app.panels.get("p1");
      const before = app.debug.panelReactions;
      panel.entries = [...panel.entries];
      panel.notify();
      await app.settled();
      expect(app.debug.panelReactions).toBe(before);
    });
  });

  describe("action commands", () => {
    it("files:copy returns a jobId synchronously", () => {
      const cmd = commands.call(filesCopy, {
        files: [{ storage: "left", path: "/src/a.txt", kind: "file" as const }],
        target: { storage: "right", path: "/dst" },
      });
      expect(cmd.settled).toBe(false);
      expect(typeof app.jobs.lastJobId()).toBe("string");
    });

    it("a host handler at priority 0 overrides the core's negative-priority handler", async () => {
      const seen: string[] = [];
      commands.listen(
        filesCopy,
        async (cmd) => {
          seen.push(cmd.payload.files[0].path);
          return { jobId: "host-job" };
        },
        { priority: 0 },
      );

      const { jobId } = await commands.call(filesCopy, {
        files: [{ storage: "left", path: "/src/a.txt", kind: "file" as const }],
        target: { storage: "right", path: "/dst" },
      }).promise;

      expect(jobId).toBe("host-job");
      expect(seen).toEqual(["/src/a.txt"]);
      expect(await right.exists("/dst/a.txt")).toBe(false); // core handler never ran
    });
  });

  describe("the job layer", () => {
    it("carries a live progress model as the payload of a UI command", async () => {
      const { jobId } = await commands.call(filesCopy, {
        files: [
          { storage: "left", path: "/src/a.txt", kind: "file" as const },
          { storage: "left", path: "/src/b.txt", kind: "file" as const },
        ],
        target: { storage: "right", path: "/dst" },
      }).promise;

      const view = views.openJobs.find((v) => v.model.id === jobId);
      expect(view, "a ui:show-job view exists for the job").toBeDefined();
      expect(view!.model).toBe(app.jobs.get(jobId)); // the same live object, not a snapshot

      await app.jobs.get(jobId).done;
      expect(view!.model.completed).toBe(2);
      expect(view!.model.total).toBe(2);
      expect(view!.renderCount).toBeGreaterThan(1); // progress observed, not just the end state
      expect(await right.exists("/dst/a.txt")).toBe(true);
    });

    it("is independent of the panel that started it", async () => {
      const { jobId } = await commands.call(filesCopy, {
        files: [{ storage: "left", path: "/src/a.txt", kind: "file" as const }],
        target: { storage: "right", path: "/dst" },
      }).promise;

      await app.panels.remove("p1");
      await app.jobs.get(jobId).done;

      expect(app.jobs.get(jobId).status).toBe("done");
      expect(await right.exists("/dst/a.txt")).toBe(true);
    });

    it("cancels", async () => {
      const { jobId } = await commands.call(filesCopy, {
        files: ["a", "b", "c"].map((n) => ({
          storage: "left",
          path: `/src/${n}.txt`,
          kind: "file" as const,
        })),
        target: { storage: "right", path: "/dst" },
      }).promise;

      const job = app.jobs.get(jobId);
      job.cancel();
      await job.done;

      expect(job.status).toBe("cancelled");
      expect(job.completed).toBeLessThan(3);
    });
  });

  it("closes the loop: a copy makes the target panel re-list on its own", async () => {
    const panel = app.panels.get("p2");
    expect(panel.entries.map((e) => e.name)).toEqual(["keep.txt"]);

    const { jobId } = await commands.call(filesCopy, {
      files: [{ storage: "left", path: "/src/a.txt", kind: "file" as const }],
      target: { storage: "right", path: "/dst" },
    }).promise;
    await app.jobs.get(jobId).done;
    await app.settled();

    expect(panel.entries.map((e) => e.name).sort()).toEqual(["a.txt", "keep.txt"]);
  });

  describe("panel-scoped commands", () => {
    it("exactly one panel claims a panelId-addressed command", async () => {
      await commands.call(panelsNavigate, { panelId: "p1", path: "/" }).promise;
      expect(app.panels.get("p1").path).toBe("/");
      expect(app.panels.get("p2").path).toBe("/dst");
    });

    it("rejects as not-claimed when the panel is gone", async () => {
      await app.panels.remove("p2");
      const err = await commands.call(panelsNavigate, { panelId: "p2", path: "/" }).promise.then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(CommandError);
      expect((err as CommandError).kind).toBe("not-claimed");
    });
  });

  it("keeps the package boundary: no view sees a controller, a FilesApi or the bus", () => {
    for (const view of views.openPanels) {
      expect(Object.keys(view.model)).not.toContain("commands");
      expect(Object.keys(view.model)).not.toContain("api");
      expect(Object.keys(view.model)).not.toContain("controller");
    }
  });
});

describe("P0 · bootstrap order", () => {
  it("a controller emitting before view handlers exist is a loud wiring bug", async () => {
    const commands = new Commands();
    const err = await commands.call(uiShowPanel, { id: "p1" } as never).promise.then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).kind).toBe("no-handlers");
    expect(uiShowJob.policy.onNoHandlers).toBe("reject");
  });
});
