import type { ConfirmView, TitleFormView } from "@p5/todos/api";
import { MemTodoApi } from "@p5/todos.core";
import { describe, expect, it } from "vitest";
import { dialog, errorLogs, panel, start, until, workbenchHeadless } from "../support/harness.js";
import { titles, todoList, toolbarAction } from "../support/scenarios.js";

/** P2 acceptance 4, on K: stopping mid-commit closes the bundle scope; nothing is written after. */
describe("dispose mid-commit (P2's tests, on scopes)", () => {
  it("todos.edit: the app stops while a save is in flight", async () => {
    const api = new MemTodoApi(undefined, 40);
    const r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r).length === 3);
    const list = todoList(r);
    list.select(["t2"]);
    list
      .getSelectionActions()
      .find((a) => a.action.getState().label === "Edit")
      ?.action.submit();
    await until(() => panel(r.slots, "todos:editor") !== undefined);
    const editor = panel<TitleFormView>(r.slots, "todos:editor")?.model as TitleFormView;
    api.fail("update", "disk full"); // a late failure would write the form: the strongest probe
    editor.editField("title", "Write it");
    editor.save.submit();
    await until(() => editor.save.getState().running);
    let notified = 0;
    editor.save.onStateUpdate(() => notified++);
    editor.onStatusUpdate(() => notified++);
    await r.stop(); // (disposing the form notifies once: `enabled` falls with it)
    notified = 0;
    await new Promise((resolve) => setTimeout(resolve, 80)); // the save lands now
    expect(notified).toBe(0);
    expect(r.slots.usage().filter((u) => u.contributions > 0)).toEqual([]);
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("todos.clear-completed: the app stops while clearing", async () => {
    const api = new MemTodoApi(undefined, 40);
    const r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r).length === 3);
    const clear = toolbarAction(todoList(r), "Clear completed");
    clear.submit();
    await until(() => dialog(r.slots, "todos:clear-completed") !== undefined);
    const confirm = dialog<ConfirmView>(r.slots, "todos:clear-completed")?.model as ConfirmView;
    confirm.confirm.submit();
    await until(() => confirm.confirm.getState().running);
    let notified = 0;
    clear.onStateUpdate(() => notified++);
    await r.stop();
    notified = 0;
    await new Promise((resolve) => setTimeout(resolve, 80)); // the removal lands now
    expect(notified).toBe(0);
    expect(clear.getState().running).toBe(true); // the disposed action kept its last value
    expect(r.slots.usage().filter((u) => u.contributions > 0)).toEqual([]);
    expect(errorLogs(r.logs)).toEqual([]);
  });
});
