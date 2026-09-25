import {
  ConfirmDialogModel,
  ConflictDialogModel,
  MenuModel,
  NotificationModel,
  PanelModel,
  PromptDialogModel,
  uiNotify,
  uiShowConfirm,
  uiShowConflict,
  uiShowMenu,
  uiShowPanel,
  uiShowPrompt,
} from "@fm/app";
import { type Renderers, ViewAdapter } from "@fm/ui";
import { type CommandError, Commands } from "@statewalker/shared-commands";
import { beforeEach, describe, expect, it } from "vitest";

/** D1 — views are command handlers, at four different lifetimes. */

describe("D1 · UI protocol", () => {
  let commands: Commands;
  let rendered: string[];
  let cleaned: string[];
  let adapter: ViewAdapter;

  const renderer = <K extends keyof Renderers>(kind: K): Renderers[K] =>
    ((view: { model: unknown; settle: (r: unknown) => void }) => {
      rendered.push(kind);
      (view as never as { _settle: unknown })._settle = view.settle;
      last[kind] = view;
      return () => cleaned.push(kind);
    }) as never;

  let last: Record<string, { model: unknown; settle: (r: unknown) => void }>;

  beforeEach(() => {
    commands = new Commands();
    rendered = [];
    cleaned = [];
    last = {};
    adapter = new ViewAdapter(commands, {
      panel: renderer("panel"),
      job: renderer("job"),
      notify: renderer("notify"),
      menu: renderer("menu"),
      confirm: renderer("confirm"),
      prompt: renderer("prompt"),
      conflict: renderer("conflict"),
    });
  });

  describe("one mechanism, four lifetimes", () => {
    it("renders a panel from ui:show-panel and keeps it open", () => {
      const model = new PanelModel("p1", "left", "mem://a", "/");
      commands.call(uiShowPanel, model);
      expect(adapter.openViews()).toEqual([{ kind: "panel", model }]);
    });

    it("renders a dialog, and closes it when the user answers", async () => {
      const call = commands.call(uiShowConfirm, new ConfirmDialogModel("delete.confirm", { n: 3 }));
      last.confirm.settle({ confirmed: true });
      await expect(call.promise).resolves.toEqual({ confirmed: true });
      await Promise.resolve();
      expect(adapter.openViews()).toEqual([]);
    });

    it("renders a menu and returns the selected key", async () => {
      const call = commands.call(uiShowMenu, new MenuModel([{ key: "files:copy" }]));
      last.menu.settle({ selectedKey: "files:copy" });
      await expect(call.promise).resolves.toEqual({ selectedKey: "files:copy" });
    });

    it("renders a notification that needs no answer", async () => {
      const call = commands.call(uiNotify, new NotificationModel("info", "job.done"));
      last.notify.settle(undefined);
      await expect(call.promise).resolves.toBeUndefined();
    });
  });

  describe("settlement", () => {
    it("closes the view when the CONTROLLER settles, not only the user", async () => {
      const call = commands.call(uiShowPanel, new PanelModel("p1", "left", "mem://a", "/"));
      call.resolve({ closed: true });
      await call.promise;
      await Promise.resolve();
      expect(adapter.openViews()).toEqual([]);
    });

    it("removal on settle is a MICROTASK, not synchronous", async () => {
      const call = commands.call(uiShowConfirm, new ConfirmDialogModel("x"));
      last.confirm.settle({ confirmed: false });
      // The bus settles through async output validation, so the view is still
      // open in this tick. A host writing teardown assertions must await.
      expect(adapter.openViews().length).toBe(1);
      await call.promise;
      await Promise.resolve();
      expect(adapter.openViews()).toEqual([]);
    });

    it("runs the renderer's cleanup when the view closes", async () => {
      const call = commands.call(uiShowPrompt, new PromptDialogModel("rename.prompt", "a.txt"));
      last.prompt.settle({ text: "b.txt" });
      await call.promise;
      await Promise.resolve();
      expect(cleaned).toEqual(["prompt"]);
    });
  });

  describe("dispose", () => {
    it("rejects outstanding commands instead of hanging their callers", async () => {
      const call = commands.call(uiShowPanel, new PanelModel("p1", "left", "mem://a", "/"));
      adapter.dispose();
      await expect(call.promise).rejects.toThrow(/view layer disposed/);
    });

    it("cleans up BEFORE the caller hears back, so 'answered' implies 'gone'", async () => {
      const call = commands.call(uiShowConfirm, new ConfirmDialogModel("x"));
      let openWhenRejected = -1;
      const settled = call.promise.catch(() => {
        openWhenRejected = adapter.openViews().length;
      });
      adapter.dispose();
      await settled;
      expect(openWhenRejected).toBe(0);
      expect(cleaned).toEqual(["confirm"]);
    });

    it("stops claiming new commands once disposed", async () => {
      adapter.dispose();
      const err = await commands.call(uiNotify, new NotificationModel("info", "x")).promise.then(
        () => null,
        (e) => e,
      );
      expect((err as CommandError).kind).toBe("no-handlers");
    });
  });

  describe("what the view layer decides for itself", () => {
    it("does not claim a kind it has no renderer for", async () => {
      const partial = new Commands();
      const bare = new ViewAdapter(partial, { panel: renderer("panel") });
      const err = await partial
        .call(uiShowConflict, new ConflictDialogModel("/a.txt", "/dst/a.txt"))
        .promise.then(
          () => null,
          (e) => e,
        );
      // Reported to the caller as not-claimed — never thrown at a controller
      // that could do nothing about it.
      expect((err as CommandError).kind).toBe("not-claimed");
      bare.dispose();
    });

    it("gives the renderer a model and a settle callback, and nothing else", () => {
      const model = new PanelModel("p1", "left", "mem://a", "/");
      commands.call(uiShowPanel, model);
      expect(Object.keys(last.panel).sort()).toEqual(["_settle", "model", "settle"]);
      // `view.model` must BE the model, not the command carrying it: a renderer
      // handed the command could settle it, inspect the bus, or read another
      // view's payload.
      expect(last.panel.model).toBe(model);
      expect(last.panel.model).not.toHaveProperty("payload");
    });
  });

  describe("progress is state, not a request", () => {
    it("has no progress command at all — the view reflects the job model", async () => {
      const { uiShowJob, JobModel } = await import("@fm/app");
      const job = new JobModel("j1");
      commands.call(uiShowJob, job);

      let renders = 0;
      job.onUpdate(() => renders++);
      job.completed = 1;
      job.notify();
      job.completed = 2;
      job.notify();

      expect(renders).toBe(2);
      expect(adapter.openViews()[0].model).toBe(job); // the live model, not a snapshot
    });
  });
});
