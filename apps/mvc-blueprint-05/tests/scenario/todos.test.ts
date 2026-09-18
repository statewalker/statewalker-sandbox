/** §14.3 Todos behaviour, headless. */
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClearCompletedProps,
  TodoEditorProps,
  TodosListProps,
} from "../../src/bundles/todos/api/index.ts";
import { todoEditorIntents, todosListIntents } from "../../src/bundles/todos/api/index.ts";
import { createMemTodoApi } from "../../src/bundles/todos.core/mem-api.ts";
import { shellFeature, todosFeature } from "../../src/features.ts";
import { gate, type Harness, start, until } from "../support/harness.ts";
import { user } from "../support/user.ts";

let h: Harness;
afterEach(async () => {
  expect(h.errors()).toEqual([]);
  await h.stop();
});

const boot = async (inject: Record<string, unknown> = {}) => {
  h = await start([shellFeature, todosFeature], inject);
  const u = user(h.store);
  await until(() => !!u.panel("todos.list"));
  const list = () => u.panel<TodosListProps>("todos.list")?.props as TodosListProps;
  const editor = () => u.panel<TodoEditorProps>("todos.edit")?.props;
  return {
    u,
    list,
    editor,
    titles: () => list().rows.map((r) => `${r.done ? "x" : " "} ${r.title}`),
  };
};

describe("todos", () => {
  it("shows the seed and the header count", async () => {
    const { u, titles } = await boot();
    expect(titles()).toEqual(["  Buy milk", "  Write report", "x Call plumber"]);
    expect(u.header()).toEqual(["2 open todos"]);
  });

  it("adds from the new-title input; Add is disabled while empty", async () => {
    const { u, list, titles } = await boot();
    expect(u.action(list().toolbar, "Add")?.enabled).toBe(false);
    h.dispatch(todosListIntents.newTitle({ title: "Feed cat" }));
    expect(u.press(u.action(list().toolbar, "Add"))).toBe(true);
    await until(() => titles().length === 4);
    expect(list().newTitle).toBe("");
    expect(u.header()).toEqual(["3 open todos"]);
  });

  it("toggles by checkbox, selects (click, ctrl-click), toggles and deletes the selection", async () => {
    const { u, list, titles } = await boot();
    h.dispatch(todosListIntents.toggle({ id: "t1" }));
    await until(() => titles()[0] === "x Buy milk");
    expect(u.header()).toEqual(["1 open todos"]);
    h.dispatch(todosListIntents.click({ id: "t1", additive: false }));
    h.dispatch(todosListIntents.click({ id: "t2", additive: true }));
    expect(
      list()
        .rows.filter((r) => r.selected)
        .map((r) => r.id),
    ).toEqual(["t1", "t2"]);
    expect(u.action(list().selectionActions, "Edit")?.enabled).toBe(false); // exactly one
    u.press(u.action(list().selectionActions, "Toggle"));
    await until(() => titles()[1] === "x Write report");
    u.press(u.action(list().selectionActions, "Delete"));
    await until(() => titles().length === 1);
    expect(titles()).toEqual(["x Call plumber"]);
  });

  it("edits: Edit opens the editor on the selected todo, Save updates and closes, Cancel withdraws", async () => {
    const { u, list, editor, titles } = await boot();
    h.dispatch(todosListIntents.click({ id: "t2", additive: false }));
    u.press(u.action(list().selectionActions, "Edit"));
    expect(editor()?.title).toBe("Write report");
    h.dispatch(todoEditorIntents.title({ title: "Write the report" }));
    u.press(editor()?.save);
    await until(() => !editor());
    expect(titles()[1]).toBe("  Write the report");
    u.press(u.action(list().selectionActions, "Edit"));
    u.press(editor()?.cancel);
    expect(editor()).toBeUndefined();
  });

  it("a failing save keeps the editor open with the error; an empty title is refused", async () => {
    const api = createMemTodoApi();
    api.update = async () => {
      throw new Error("disk full");
    };
    const { u, list, editor } = await boot({ "todos:api": api });
    h.dispatch(todosListIntents.click({ id: "t1", additive: false }));
    u.press(u.action(list().selectionActions, "Edit"));
    h.dispatch(todoEditorIntents.title({ title: "  " }));
    u.press(editor()?.save);
    expect(editor()?.error).toBe("Title is required");
    h.dispatch(todoEditorIntents.title({ title: "Buy oat milk" }));
    u.press(editor()?.save);
    await until(() => editor()?.error === "disk full");
    expect(editor()?.save.enabled).toBe(true);
  });

  it("New todo… (menu) opens the editor in create mode; Save adds", async () => {
    const { u, editor, titles } = await boot();
    u.press(u.menuItem("New todo…"));
    expect(editor()).toMatchObject({ mode: "create", title: "" });
    h.dispatch(todoEditorIntents.title({ title: "Water plants" }));
    u.press(editor()?.save);
    await until(() => titles().length === 4 && !editor());
    expect(titles()[3]).toBe("  Water plants");
  });

  it("Clear completed asks, removes those done when asked, and notifies how many", async () => {
    const g = gate();
    const api = createMemTodoApi({ delay: () => g.wait() });
    g.openAll();
    const { u, list, titles } = await boot({ "todos:api": api });
    const dialog = () => u.dialog<ClearCompletedProps>("todos.clear-completed")?.props;
    u.press(u.action(list().toolbar, "Clear completed"));
    expect(dialog()?.count).toBe(1);
    // After asking, the user completes another todo: it is not part of the question.
    h.dispatch(todosListIntents.toggle({ id: "t1" }));
    await until(() => titles()[0] === "x Buy milk");
    u.press(dialog()?.confirm);
    await until(() => !dialog());
    expect(titles()).toEqual(["x Buy milk", "  Write report"]);
    expect(u.toasts()).toEqual(["success:Removed 1 completed todo"]);
  });

  it("the menu has the Todos group with New todo… and Clear completed", async () => {
    const { u } = await boot();
    expect(
      u
        .menu()
        .map((m) => `${m.groupLabel}/${m.label}`)
        .sort(),
    ).toEqual(["Todos/Clear completed", "Todos/New todo…"]);
  });
});
