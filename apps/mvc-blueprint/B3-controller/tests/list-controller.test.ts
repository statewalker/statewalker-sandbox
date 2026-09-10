import { Commands } from "@statewalker/shared-commands";
import { beforeEach, describe, expect, it } from "vitest";
import { MemTodoApi, registerTodoCommands, todosAdd } from "@todo/core";
import { ListController, TodoListModel, expectCoalescedEdge, expectNoSelfWake } from "@todo/app";


const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("B3 · list controller", () => {
  let commands: Commands;
  let api: MemTodoApi;
  let model: TodoListModel;
  let controller: ListController;

  beforeEach(() => {
    commands = new Commands();
    api = new MemTodoApi([{ id: "1", title: "seed", done: false }]);
    registerTodoCommands(commands, api);
    model = new TodoListModel();
    controller = new ListController(model, commands, api);
    controller.activate();
  });

  it("loads the api into the model on activate", async () => {
    await tick();
    expect(model.todos.map((t) => t.id)).toEqual(["1"]);
  });

  it("drains the pending queue, one todo per queued item", async () => {
    await tick();
    model.input.queueSubmit("a");
    model.input.queueSubmit("b");
    await tick();
    await tick();
    expect(model.todos.map((t) => t.title)).toEqual(["seed", "a", "b"]);
    expect(model.input.pending, "the queue must be replaced with [] on drain").toEqual([]);
  });

  it("coalesces refresh: two increments in one tick are one reload", async () => {
    await tick();
    expectCoalescedEdge({
      bump: () => model.input.requestRefresh(),
      read: () => model.input.refreshCount,
      actions: () => controller.debug.reloads,
      label: "refreshCount",
    });
  });

  it("does not wake itself when it writes the outer model", async () => {
    await tick();
    await expectNoSelfWake({
      reactions: () => controller.debug.reactions,
      writeOuter: () =>
        model.replaceTodos([...model.todos, { id: "9", title: "by controller", done: false }]),
      writeInput: () => model.input.requestRefresh(),
    });
  });

  it("is not woken by a level change it does not subscribe to", async () => {
    await tick();
    const before = controller.debug.reactions;
    model.input.setFilter("anything");
    await tick();
    expect(controller.debug.reactions, "filtering is view state, not a reload").toBe(before);
  });

  it("writes outcomes to the OUTER model, so live typing is never wiped", async () => {
    await tick();
    model.input.setFilter("half-typed");
    await commands.call(todosAdd, { title: "x" }).promise;
    model.input.requestRefresh();
    await tick();
    expect(model.input.filterDraft).toBe("half-typed");
  });

  it("stops reacting after dispose", async () => {
    await tick();
    const before = controller.debug.reactions;
    await controller.dispose();
    model.input.requestRefresh();
    await tick();
    expect(controller.debug.reactions).toBe(before);
  });
});
