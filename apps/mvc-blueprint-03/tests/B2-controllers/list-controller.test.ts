import { notify } from "@notifications/commands";
import {
  panelsSlot,
  todosSelectionActionsSlot,
  todosToolbarActionsSlot,
} from "@sys/extension-points";
import { todosClearCompletedAsk } from "@todos/clear-completed/commands";
import { todosEditOpen } from "@todos/edit/commands";
import { todosChanged } from "@todos/events";
import { TodoListController, todoListKind } from "@todos/list";
import { describe, expect, it } from "vitest";
import { newTestContext, settle } from "../support/context.js";

const rows = [
  { id: "t1", title: "Buy milk", done: false },
  { id: "t2", title: "Walk dog", done: true },
  { id: "t3", title: "Read book", done: false },
];

async function start(seed = rows) {
  const env = newTestContext(seed);
  const controller = new TodoListController();
  controller.activate(env.ctx);
  await controller.whenIdle();
  return { ...env, controller, view: controller.model.view, control: controller.model.control };
}

describe("B2 · todo list controller", () => {
  it("provides its panel and its actions, and loads the todos", async () => {
    const { slots, controller, view } = await start();
    const panel = slots.get(panelsSlot, "todos:list");
    expect(panel).toMatchObject({
      kind: todoListKind,
      title: "Todos",
      placement: "main",
      model: view,
    });
    expect(slots.getSnapshot(todosToolbarActionsSlot).map((c) => [c.id, c.order])).toEqual([
      ["todos.add", 10],
      ["todos.clear-completed", 20],
    ]);
    expect(slots.getSnapshot(todosSelectionActionsSlot).map((c) => [c.id, c.order])).toEqual([
      ["todos.toggle", 10],
      ["todos.edit", 20],
      ["todos.remove", 30],
    ]);
    expect(slots.getSnapshot(todosSelectionActionsSlot)[0].action).toBe(view.actions.toggle);
    expect(view.getItems().map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    await controller.dispose();
  });

  it("Add adds the new title, clears it, reloads and logs", async () => {
    const { api, recorder, controller, view } = await start();
    view.setNewTitle("  Call mum ");
    view.actions.add.submit();
    await settle();
    expect(view.getItems().map((t) => t.title)).toContain("Call mum");
    expect(view.getNewTitle()).toBe("");
    expect(api.calls.filter((c) => c === "add")).toHaveLength(1);
    expect(recorder.calls).toContainEqual({
      level: "info",
      args: ["action:add", { id: "t4" }],
      metadata: { module: "todos.list" },
    });
    await controller.dispose();
  });

  it("two submits in one tick run the intent once", async () => {
    const { api, controller, view } = await start();
    view.setNewTitle("Once");
    view.actions.add.submit();
    view.actions.add.submit();
    await settle();
    expect(api.calls.filter((c) => c === "add")).toHaveLength(1);
    await controller.dispose();
  });

  it("the action is running while the intent runs, and idle after", async () => {
    const { controller, view } = await start();
    view.select(["t1", "t3"]);
    view.actions.toggle.submit();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.actions.toggle.getState().running).toBe(true);
    await settle();
    expect(view.actions.toggle.getState().running).toBe(false);
    expect(
      view
        .getItems()
        .filter((t) => t.done)
        .map((t) => t.id),
    ).toEqual(["t1", "t2", "t3"]);
    await controller.dispose();
  });

  it("Delete removes the selection, and the selection forgets the removed ids", async () => {
    const { controller, view } = await start();
    view.select(["t2", "t3"]);
    view.actions.remove.submit();
    await settle();
    expect(view.getItems().map((t) => t.id)).toEqual(["t1"]);
    expect(view.getSelection()).toEqual([]);
    await controller.dispose();
  });

  it("Edit asks the edit domain to open the selected todo", async () => {
    const { commands, controller, view } = await start();
    const opened: string[] = [];
    commands.listen(todosEditOpen, (cmd) => {
      opened.push(cmd.payload.id);
      return Promise.resolve({ opened: true });
    });
    view.select(["t3"]);
    view.actions.edit.submit();
    await settle();
    expect(opened).toEqual(["t3"]);
    expect(view.getOutcome()).toBeUndefined();
    await controller.dispose();
  });

  it("Clear completed asks the clear-completed domain", async () => {
    const { commands, controller, view } = await start();
    let asked = 0;
    commands.listen(todosClearCompletedAsk, () => {
      asked++;
      return Promise.resolve({ asked: true });
    });
    view.actions.clearCompleted.submit();
    await settle();
    expect(asked).toBe(1);
    await controller.dispose();
  });

  it("a command with no handler is reported, disables its action and asks for an error toast", async () => {
    const { commands, controller, view } = await start();
    const toasts: { text: string; level: string }[] = [];
    commands.listen(notify, (cmd) => {
      toasts.push(cmd.payload);
      return Promise.resolve({ shown: true });
    });
    view.select(["t1"]);
    view.actions.edit.submit();
    await settle();
    expect(view.getOutcome()).toBe("open the editor failed: no-handlers: todos:edit:open");
    expect(view.actions.edit.getState().enabled).toBe(false);
    expect(toasts).toEqual([
      { text: "open the editor failed: no-handlers: todos:edit:open", level: "error" },
    ]);
    await controller.dispose();
  });

  it("an api failure becomes the outcome; the next success clears it", async () => {
    const { api, controller, view } = await start();
    api.fail("add", "disk full");
    view.setNewTitle("Doomed");
    view.actions.add.submit();
    await settle();
    expect(view.getOutcome()).toBe('add "Doomed" failed: disk full');
    expect(view.actions.add.getState().running).toBe(false);
    expect(view.getNewTitle()).toBe("Doomed");
    api.heal("add");
    view.actions.add.submit();
    await settle();
    expect(view.getOutcome()).toBeUndefined();
    await controller.dispose();
  });

  it("todos:changed from another domain reloads the list", async () => {
    const { api, commands, controller, view } = await start();
    await api.add("added elsewhere");
    commands.call(todosChanged, { source: "todos.edit" });
    await settle();
    expect(view.getItems().map((t) => t.title)).toContain("added elsewhere");
    await controller.dispose();
  });

  it("Toggle snapshots the selection at submit time, not when the pass runs", async () => {
    const { controller, view } = await start();
    view.select(["t1"]);
    view.actions.toggle.submit();
    view.select(["t3"]);
    await settle();
    expect(view.getItems().find((t) => t.id === "t1")?.done).toBe(true);
    expect(view.getItems().find((t) => t.id === "t3")?.done).toBe(false);
    await controller.dispose();
  });

  it("Add snapshots the title at submit time; a title typed afterward survives", async () => {
    const { controller, view } = await start();
    view.setNewTitle("A");
    view.actions.add.submit();
    view.setNewTitle("B");
    await settle();
    expect(view.getItems().map((t) => t.title)).toContain("A");
    expect(view.getNewTitle()).toBe("B");
    await controller.dispose();
  });

  it("Delete snapshots the selection at submit time, not when the pass runs", async () => {
    const { controller, view } = await start();
    view.select(["t2", "t3"]);
    view.actions.remove.submit();
    view.select([]);
    await settle();
    expect(view.getItems().map((t) => t.id)).toEqual(["t1"]);
    await controller.dispose();
  });

  it("dispose right after a submit, before the pass runs: no api call, no outcome, no toast", async () => {
    const { api, commands, controller, view } = await start();
    const toasts: { text: string; level: string }[] = [];
    commands.listen(notify, (cmd) => {
      toasts.push(cmd.payload);
      return Promise.resolve({ shown: true });
    });
    view.setNewTitle("Ghost");
    view.actions.add.submit();
    await controller.dispose();
    await settle();
    expect(api.calls.filter((c) => c === "add")).toHaveLength(0);
    expect(view.getOutcome()).toBeUndefined();
    expect(toasts).toEqual([]);
  });

  it("a failed intent writes an error log record", async () => {
    const { api, recorder, controller, view } = await start();
    api.fail("add", "disk full");
    view.setNewTitle("Doomed");
    view.actions.add.submit();
    await settle();
    expect(recorder.calls).toContainEqual({
      level: "error",
      args: ['add "Doomed" failed: disk full'],
      metadata: { module: "todos.list" },
    });
    await controller.dispose();
  });

  it("a failing reload sets the outcome", async () => {
    const { api, commands, controller, view } = await start();
    api.fail("list", "db down");
    commands.call(todosChanged, { source: "todos.edit" });
    await settle();
    expect(view.getOutcome()).toBe("load todos failed: db down");
    await controller.dispose();
  });

  it("Clear completed with no handler is reported and disables its action", async () => {
    const { controller, view } = await start();
    view.actions.clearCompleted.submit();
    await settle();
    expect(view.getOutcome()).toBe(
      "clear completed failed: no-handlers: todos:clear-completed:ask",
    );
    expect(view.actions.clearCompleted.getState().enabled).toBe(false);
    await controller.dispose();
  });

  it("dispose withdraws the panel and every action, and stops listening", async () => {
    const { api, commands, slots, controller } = await start();
    await controller.dispose();
    expect(slots.getSnapshot(panelsSlot).size).toBe(0);
    expect(slots.getSnapshot(todosToolbarActionsSlot)).toEqual([]);
    expect(slots.getSnapshot(todosSelectionActionsSlot)).toEqual([]);
    const lists = api.calls.filter((c) => c === "list").length;
    commands.call(todosChanged, { source: "late" });
    await settle();
    expect(api.calls.filter((c) => c === "list")).toHaveLength(lists);
  });
});
