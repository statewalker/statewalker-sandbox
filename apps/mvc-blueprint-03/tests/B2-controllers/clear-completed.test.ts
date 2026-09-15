import { notify } from "@notifications/commands";
import { dialogsSlot } from "@sys/extension-points";
import {
  ClearCompletedController,
  type ConfirmView,
  clearCompletedConfirmKind,
  createConfirmModel,
  todosClearCompletedAsk,
} from "@todos/clear-completed";
import { setTodoApi } from "@todos/core";
import { todosChanged } from "@todos/events";
import { describe, expect, it } from "vitest";
import { ScriptedTodoApi } from "../support/api.js";
import { newTestContext, settle } from "../support/context.js";

const rows = [
  { id: "t1", title: "Buy milk", done: true },
  { id: "t2", title: "Walk dog", done: true },
  { id: "t3", title: "Read book", done: false },
];

/** Succeeds its first `remove`, then fails every later one — unlike `ScriptedTodoApi.fail`, which fails every call. */
class FlakyRemoveApi extends ScriptedTodoApi {
  private _removeCalls = 0;

  override async remove(id: string): Promise<boolean> {
    this._removeCalls++;
    if (this._removeCalls >= 2) throw new Error("locked");
    return super.remove(id);
  }
}

async function start(seed = rows, api?: ScriptedTodoApi) {
  const env = newTestContext(seed);
  if (api) setTodoApi(env.ctx, api);
  const controller = new ClearCompletedController();
  controller.activate(env.ctx);
  const toasts: { text: string; level: string }[] = [];
  env.commands.listen(notify, (cmd) => {
    toasts.push(cmd.payload);
    return Promise.resolve({ shown: true });
  });
  const changed: string[] = [];
  env.commands.listen(todosChanged, (cmd) => {
    changed.push(cmd.payload.source);
  });
  const dialogs = () => env.slots.getSnapshot(dialogsSlot);
  return { ...env, api: api ?? env.api, controller, toasts, changed, dialogs };
}

describe("B2 · clear-completed", () => {
  it("the confirm model carries its question and two actions", () => {
    const m = createConfirmModel({ text: "Delete 2 completed todos?", count: 2 });
    expect(m.view.getQuestion()).toEqual({ text: "Delete 2 completed todos?", count: 2 });
    expect(m.view.actions.ok.getState()).toMatchObject({
      label: "Clear",
      icon: "trash-2",
      enabled: true,
    });
    expect(m.view.actions.cancel.getState()).toMatchObject({
      label: "Cancel",
      icon: "x",
      enabled: true,
    });
    m.dispose();
    expect(m.view.actions.ok.getState().enabled).toBe(false);
  });

  it("with nothing completed, ask resolves not asked and shows nothing", async () => {
    const { commands, controller, dialogs } = await start([{ id: "t1", title: "x", done: false }]);
    await expect(commands.call(todosClearCompletedAsk, {}).promise).resolves.toEqual({
      asked: false,
    });
    expect(dialogs()).toEqual([]);
    await controller.dispose();
  });

  it("ask shows the question and resolves at once, without waiting for an answer", async () => {
    const { commands, controller, dialogs } = await start();
    await expect(commands.call(todosClearCompletedAsk, {}).promise).resolves.toEqual({
      asked: true,
    });
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0].kind).toBe(clearCompletedConfirmKind);
    expect((dialogs()[0].model as ConfirmView).getQuestion()).toEqual({
      text: "Delete 2 completed todos?",
      count: 2,
    });
    await controller.dispose();
  });

  it("a second ask while the question is open adds no second dialog", async () => {
    const { commands, controller, dialogs } = await start();
    await commands.call(todosClearCompletedAsk, {}).promise;
    await expect(commands.call(todosClearCompletedAsk, {}).promise).resolves.toEqual({
      asked: true,
    });
    expect(dialogs()).toHaveLength(1);
    await controller.dispose();
  });

  it("OK deletes the completed todos, broadcasts the change, says so and closes", async () => {
    const { api, commands, recorder, controller, toasts, changed, dialogs } = await start();
    await commands.call(todosClearCompletedAsk, {}).promise;
    controller.current?.view.actions.ok.submit();
    await settle();
    expect((await api.list()).map((t) => t.id)).toEqual(["t3"]);
    expect(dialogs()).toEqual([]);
    expect(changed).toEqual(["todos.clear-completed"]);
    expect(toasts).toEqual([{ text: "Cleared 2 completed todos", level: "info" }]);
    expect(recorder.calls).toContainEqual({
      level: "info",
      args: ["action:clear-completed", { count: 2 }],
      metadata: { module: "todos.clear-completed" },
    });
    await controller.dispose();
  });

  it("OK acts on the question it asked: the todos done at ask time, skipping ones already gone", async () => {
    const { api, commands, recorder, controller, toasts, changed } = await start();
    await commands.call(todosClearCompletedAsk, {}).promise;
    // While the question is open: t3 is ticked, and t2 is deleted elsewhere.
    await api.update("t3", { done: true });
    await api.remove("t2");
    controller.current?.view.actions.ok.submit();
    await settle();
    expect((await api.list()).map((t) => t.id)).toEqual(["t3"]);
    expect(changed).toEqual(["todos.clear-completed"]);
    expect(toasts).toEqual([{ text: "Cleared 1 completed todo", level: "info" }]);
    expect(recorder.calls).toContainEqual({
      level: "info",
      args: ["action:clear-completed", { count: 1 }],
      metadata: { module: "todos.clear-completed" },
    });
    await controller.dispose();
  });

  it("Cancel closes the question and deletes nothing", async () => {
    const { api, commands, controller, dialogs } = await start();
    await commands.call(todosClearCompletedAsk, {}).promise;
    controller.current?.view.actions.cancel.submit();
    await settle();
    expect(dialogs()).toEqual([]);
    expect(api.calls).not.toContain("remove");
    await controller.dispose();
  });

  it("a failure is toasted and the question is closed", async () => {
    const { api, commands, controller, toasts, changed, dialogs } = await start();
    await commands.call(todosClearCompletedAsk, {}).promise;
    api.fail("remove", "locked");
    controller.current?.view.actions.ok.submit();
    await settle();
    expect(toasts).toEqual([{ text: "clear completed failed: locked", level: "error" }]);
    expect(changed).toEqual([]);
    expect(dialogs()).toEqual([]);
    await controller.dispose();
  });

  it("a failure part-way still broadcasts what was removed before it", async () => {
    const flaky = new FlakyRemoveApi(rows);
    const { api, commands, controller, toasts, changed, dialogs } = await start(rows, flaky);
    await commands.call(todosClearCompletedAsk, {}).promise;
    controller.current?.view.actions.ok.submit();
    await settle();
    expect((await api.list()).map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(changed).toEqual(["todos.clear-completed"]);
    expect(toasts).toEqual([{ text: "clear completed failed: locked", level: "error" }]);
    expect(dialogs()).toEqual([]);
    await controller.dispose();
  });

  it("dispose withdraws an open question", async () => {
    const { commands, controller, dialogs } = await start();
    await commands.call(todosClearCompletedAsk, {}).promise;
    await controller.dispose();
    expect(dialogs()).toEqual([]);
  });
});
