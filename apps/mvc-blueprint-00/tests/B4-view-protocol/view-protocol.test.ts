import { type CommandError, Commands } from "@statewalker/shared-commands";
// The view layer's suite takes what the view layer may take: models and declarations.
import {
  ConfirmModel,
  NotifyModel,
  TodoListModel,
  uiConfirm,
  uiNotify,
  uiShowList,
} from "@todo/app/models";
import { ViewAdapter, viewLayer } from "@todo/ui/adapter";
import { beforeEach, describe, expect, it } from "vitest";

describe("B4 · view protocol", () => {
  let commands: Commands;
  let adapter: ViewAdapter;
  let rendered: string[];
  let cleaned: string[];

  beforeEach(() => {
    commands = new Commands();
    rendered = [];
    cleaned = [];
    adapter = new ViewAdapter(commands);
  });

  it("renders a long-lived view and keeps it open until the caller settles", async () => {
    let settleIt: ((r: { closed: boolean }) => void) | undefined;
    adapter.on(uiShowList, (view) => {
      rendered.push("list");
      settleIt = view.settle;
      return () => cleaned.push("list");
    });

    const cmd = commands.call(uiShowList, new TodoListModel());
    expect(rendered).toEqual(["list"]);
    expect(adapter.openViews().map((v) => v.key)).toEqual(["ui:show-list"]);
    expect(cmd.settled).toBe(false);

    settleIt?.({ closed: true });
    await cmd.promise;
    expect(cleaned).toEqual(["list"]);
    expect(adapter.openViews()).toEqual([]);
  });

  it("lets the CONTROLLER force-close a view — termination is symmetric", async () => {
    adapter.on(uiShowList, () => {
      rendered.push("list");
      return () => cleaned.push("list");
    });
    const cmd = commands.call(uiShowList, new TodoListModel());
    cmd.resolve({ closed: true });
    await cmd.promise;
    expect(cleaned).toEqual(["list"]);
  });

  it("hands the renderer the model and nothing else", async () => {
    const model = new TodoListModel();
    let seen: unknown;
    adapter.on(uiShowList, (view) => {
      seen = Object.keys(view).sort();
      view.settle({ closed: true });
    });
    await commands.call(uiShowList, model).promise;
    expect(seen).toEqual(["model", "settle"]);
  });

  it("carries a typed result back to the caller — a dialog is a short-lived view", async () => {
    adapter.on(uiConfirm, (view) => {
      expect(view.model.question).toBe("Delete 2 todos?");
      view.settle({ confirmed: true });
    });
    const { confirmed } = await commands.call(uiConfirm, new ConfirmModel("Delete 2 todos?"))
      .promise;
    expect(confirmed).toBe(true);
  });

  it("settles a fire-and-forget view itself", async () => {
    adapter.on(uiNotify, (view) => {
      view.settle(undefined as never);
    });
    await commands.call(uiNotify, new NotifyModel("3 items cleared")).promise;
    expect(adapter.openViews()).toEqual([]);
  });

  it("reports an UNREGISTERED view kind as no-handlers — the wiring bug, loudly", async () => {
    // Spec §4.1: with a declaration-keyed adapter there is no listener at all
    // for a kind nobody registered, which is a different (and better) diagnosis
    // than fm-protos' `not-claimed`.
    const err = await commands.call(uiConfirm, new ConfirmModel("?")).promise.then(
      () => undefined,
      (e: CommandError) => e,
    );
    expect(err?.kind).toBe("no-handlers");
  });

  it("still reports not-claimed when a renderer declines by returning nothing", async () => {
    adapter.on(uiConfirm, () => undefined);
    const err = await commands.call(uiConfirm, new ConfirmModel("?")).promise.then(
      () => undefined,
      (e: CommandError) => e,
    );
    expect(err?.kind).toBe("not-claimed");
  });

  it("identifies an open view by its COMMAND KEY, with no parallel view-name", async () => {
    // Spec §4.1: fm-protos carried a `kind` ("panel", "job") alongside the
    // declaration it was bound to — two names for one thing, which can disagree.
    // The declaration's own key is the only identifier, and it is the same
    // string the menu, the logs and any host override use.
    adapter.on(uiShowList, () => () => {});
    adapter.on(uiConfirm, () => () => {});
    commands.call(uiShowList, new TodoListModel());
    commands.call(uiConfirm, new ConfirmModel("?"));
    expect(
      adapter
        .openViews()
        .map((v) => v.key)
        .sort(),
    ).toEqual([uiConfirm.key, uiShowList.key].sort());
    // and those keys are the declared command keys, not a renderer alias
    expect(uiShowList.key).toBe("ui:show-list");
  });

  it("settles a view that is still open when the adapter is disposed", async () => {
    adapter.on(uiShowList, () => () => cleaned.push("list"));
    const cmd = commands.call(uiShowList, new TodoListModel());
    expect(adapter.openViews()).toHaveLength(1);
    await adapter.dispose();
    expect(cleaned, "the renderer's cleanup must still run").toEqual(["list"]);
    expect(adapter.openViews(), "and the view must be closed").toEqual([]);
    // The caller must not be left awaiting forever.
    await expect(cmd.promise).rejects.toThrow(/disposed/);
  }, 3000);

  it("unbinds every renderer on dispose", async () => {
    adapter.on(uiShowList, () => undefined);
    await adapter.dispose();
    const err = await commands.call(uiShowList, new TodoListModel()).promise.then(
      () => undefined,
      (e: CommandError) => e,
    );
    expect(err?.kind).toBe("no-handlers");
  });

  describe("viewLayer — the installer bootstrap's registerViews takes", () => {
    it("returns the adapter's dispose, which unbinds what install registered", async () => {
      const dispose = viewLayer((a) => {
        a.on(uiShowList, () => () => {});
      })(commands);
      await dispose();
      await expect(commands.call(uiShowList, new TodoListModel()).promise).rejects.toMatchObject({
        kind: "no-handlers",
      });
    });

    it("an install that throws partway leaks no listener it had already registered", async () => {
      // bootstrap never receives a cleanup from a registerViews that threw,
      // so nothing else would ever unbind the renderers registered before the
      // throw — a half-installed view layer answering commands for ever.
      const install = viewLayer((a) => {
        a.on(uiShowList, () => () => {});
        throw new Error("second renderer failed to build");
      });
      expect(() => install(commands)).toThrow("second renderer failed to build");
      await new Promise((resolve) => setTimeout(resolve, 0)); // the async dispose's unwinding
      await expect(commands.call(uiShowList, new TodoListModel()).promise).rejects.toMatchObject({
        kind: "no-handlers",
      });
    });
  });
});
