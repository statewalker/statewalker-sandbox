import { Commands } from "@statewalker/shared-commands";
import { describe, expect, it } from "vitest";
import { MemTodoApi } from "@todo/core";
import { TodoListModel, bootstrap } from "@todo/app";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("B4 · bootstrap ordering", () => {
  it("registers the view layer BEFORE any controller can be created", async () => {
    const order: string[] = [];
    const app = bootstrap({
      commands: new Commands(),
      api: new MemTodoApi(),
      registerViews: () => { order.push("views"); },
    });
    app.createList(new TodoListModel());
    order.push("controller");
    expect(order).toEqual(["views", "controller"]);
    await app.dispose();
  });

  it("makes a controller unreachable except through the capability", async () => {
    // There is no other construction path: the only way to obtain an activated
    // ListController is createList(), which cannot run before registerViews did.
    const app = bootstrap({
      commands: new Commands(),
      api: new MemTodoApi(),
      registerViews: () => {},
    });
    const controller = app.createList(new TodoListModel());
    await tick();
    expect(controller.debug.reloads).toBeGreaterThan(0);
    await app.dispose();
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
});
