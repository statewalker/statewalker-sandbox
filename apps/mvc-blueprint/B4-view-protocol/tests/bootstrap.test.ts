import { Commands } from "@statewalker/shared-commands";
import { describe, expect, it } from "vitest";
import { MemTodoApi } from "@todo/core";
import { ListController, TodoListModel, bootstrap } from "@todo/app";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("B4 · bootstrap ordering", () => {
  it("registers the view layer BEFORE any controller can be created", async () => {
    // This proves `registerViews` runs, and returns, before `bootstrap()` gives
    // the caller anything to create a controller with — otherwise the test's
    // own "controller" marker below could not land after "views". It does NOT
    // by itself observe construction order from inside `bootstrap`; that half
    // is closed structurally by the `ViewsReady` token (see "refuses to
    // activate" below), which makes an out-of-order activation throw rather
    // than merely go untested.
    const order: string[] = [];
    const app = bootstrap({
      commands: new Commands(),
      api: new MemTodoApi(),
      registerViews: () => {
        order.push("views");
      },
    });
    app.createList(new TodoListModel());
    order.push("controller");
    expect(order).toEqual(["views", "controller"]);
    await app.dispose();
  });

  it("refuses to activate a controller that did not come through the capability", () => {
    const controller = new ListController(new TodoListModel(), new Commands(), new MemTodoApi());
    expect(() => controller.activate(undefined as never)).toThrow(/before the view layer/);
  });

  it("supports controllers created AFTER bootstrap returned — the shell's case", async () => {
    const app = bootstrap({
      commands: new Commands(),
      api: new MemTodoApi(),
      registerViews: () => {},
    });
    await tick();
    const late = app.createList(new TodoListModel());
    await tick();
    expect(late.debug.reloads).toBeGreaterThan(0);
    await app.dispose();
  });

  it("disposes every controller it handed out", async () => {
    const app = bootstrap({
      commands: new Commands(),
      api: new MemTodoApi(),
      registerViews: () => {},
    });
    const model = new TodoListModel();
    const controller = app.createList(model);
    await tick();
    const before = controller.debug.reactions;
    await app.dispose();
    model.input.requestRefresh();
    await tick();
    expect(controller.debug.reactions).toBe(before);
  });

  it("tears down in the reverse of registration order: controllers, then views", async () => {
    const order: string[] = [];
    const app = bootstrap({
      commands: new Commands(),
      api: new MemTodoApi(),
      registerViews: () => () => {
        order.push("views");
      },
    });
    const controller = app.createList(new TodoListModel());
    await tick();

    // Observe the controller's own disposal in the same array. Bootstrap's
    // teardown calls `controller.dispose()` by property lookup at cleanup
    // time (`register(() => controller.dispose())`), so shadowing the method
    // on the instance here is visible to that call without touching
    // production code.
    const originalDispose = controller.dispose.bind(controller);
    controller.dispose = async () => {
      order.push("controller");
      await originalDispose();
    };

    await app.dispose();
    expect(order).toEqual(["controller", "views"]);
  });
});
