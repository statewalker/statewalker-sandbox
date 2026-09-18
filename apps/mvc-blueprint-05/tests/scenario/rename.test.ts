/** §14.6 Rename a todo, headless: enabled with exactly one selected; commit-time title; empty refused. */
import { afterEach, describe, expect, it } from "vitest";
import {
  type RenameTodoProps,
  renameTodoIntents,
  type TodosListProps,
  todosListIntents,
} from "../../src/bundles/todos/api/index.ts";
import { createMemTodoApi } from "../../src/bundles/todos.core/mem-api.ts";
import { shellFeature, todosFeature } from "../../src/features.ts";
import { type Harness, start, until } from "../support/harness.ts";
import { user } from "../support/user.ts";

let h: Harness;
afterEach(async () => {
  expect(h.errors()).toEqual([]);
  await h.stop();
});

describe("rename a todo", () => {
  it("Rename… needs exactly one selected; renames at commit time; empty is refused", async () => {
    h = await start([shellFeature, todosFeature], { "todos:api": createMemTodoApi({ delay: 5 }) });
    const u = user(h.store);
    await until(() => !!u.panel("todos.list"));
    const list = () => u.panel<TodosListProps>("todos.list")?.props as TodosListProps;
    const dialog = () => u.dialog<RenameTodoProps>("todos.rename")?.props;
    expect(u.action(list().selectionActions, "Rename…")?.enabled).toBe(false);
    h.dispatch(todosListIntents.click({ id: "t1", additive: false }));
    h.dispatch(todosListIntents.click({ id: "t2", additive: true }));
    expect(u.action(list().selectionActions, "Rename…")?.enabled).toBe(false);
    h.dispatch(todosListIntents.click({ id: "t2", additive: false }));
    u.press(u.action(list().selectionActions, "Rename…"));
    expect(dialog()?.title).toBe("Write report");
    h.dispatch(renameTodoIntents.title({ title: " " }));
    u.press(dialog()?.rename);
    expect(dialog()?.error).toBe("Title is required");
    h.dispatch(renameTodoIntents.title({ title: "Write the report" }));
    u.press(dialog()?.rename);
    h.dispatch(renameTodoIntents.title({ title: "typed after commit" }));
    await until(() => !dialog());
    expect(list().rows[1]?.title).toBe("Write the report");
  });
});
