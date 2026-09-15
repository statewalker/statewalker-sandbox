import { describe, expect, it, vi } from "vitest";
import { createTodoListModel } from "../../src/lib/todos/list/list.model.impl.js";

const rows = [
  { id: "a", title: "Buy milk", done: false },
  { id: "b", title: "Walk dog", done: true },
  { id: "c", title: "Read book", done: false },
];

describe("B2 · todo list model", () => {
  it("visible follows the items and the query, and is silent when the filtered result is unchanged", () => {
    const m = createTodoListModel();
    const listener = vi.fn();
    m.view.onVisibleUpdate(listener);
    m.view.setShowDone(false);
    m.control.replaceItems(rows);
    expect(m.view.getVisible().map((t) => t.id)).toEqual(["a", "c"]);
    m.view.setFilter("  BOOK ");
    expect(m.view.getVisible().map((t) => t.id)).toEqual(["c"]);
    m.view.setShowDone(true);
    m.view.setFilter("");
    expect(m.view.getVisible().map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("replaceItems is silent when every todo is field-equal, and freezes what it stores", () => {
    const m = createTodoListModel();
    m.control.replaceItems(rows);
    const items = m.view.getItems();
    const listener = vi.fn();
    m.view.onItemsUpdate(listener);
    m.control.replaceItems(rows.map((t) => ({ ...t })));
    expect(m.view.getItems()).toBe(items);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(items)).toBe(true);
    expect(Object.isFrozen(items[0])).toBe(true);
  });

  it("select de-duplicates, is silent when equal, and replaceItems drops ids that are gone", () => {
    const m = createTodoListModel();
    m.control.replaceItems(rows);
    const listener = vi.fn();
    m.view.onSelectionUpdate(listener);
    m.view.select(["a", "b", "a"]);
    expect(m.view.getSelection()).toEqual(["a", "b"]);
    m.view.select(["a", "b"]);
    expect(listener).toHaveBeenCalledTimes(2);
    m.control.replaceItems(rows.filter((t) => t.id !== "b"));
    expect(m.view.getSelection()).toEqual(["a"]);
  });

  it("enablement is derived from the model's data, synchronously", () => {
    const m = createTodoListModel();
    const { actions } = m.view;
    const enabled = () =>
      Object.fromEntries(
        Object.entries(actions).map(([key, action]) => [key, action.getState().enabled]),
      );
    expect(enabled()).toEqual({
      add: false,
      toggle: false,
      remove: false,
      edit: false,
      clearCompleted: false,
    });
    m.control.replaceItems(rows);
    m.view.setNewTitle("  ");
    expect(enabled()).toMatchObject({ add: false, clearCompleted: true });
    m.view.setNewTitle("Call mum");
    m.view.select(["a"]);
    expect(enabled()).toEqual({
      add: true,
      toggle: true,
      remove: true,
      edit: true,
      clearCompleted: true,
    });
    m.view.select(["a", "c"]);
    expect(enabled()).toMatchObject({ toggle: true, remove: true, edit: false });
  });

  it("a row gesture — select, then submit in the same tick — raises the intent", () => {
    const m = createTodoListModel();
    m.control.replaceItems(rows);
    m.view.select(["c"]);
    m.view.actions.toggle.submit();
    expect(m.control.actions.toggle.getSubmits()).toBe(1);
  });

  it("labels and icons are the list's", () => {
    const m = createTodoListModel();
    const labels = Object.fromEntries(
      Object.entries(m.view.actions).map(([key, a]) => [
        key,
        [a.getState().label, a.getState().icon],
      ]),
    );
    expect(labels).toEqual({
      add: ["Add", "plus"],
      toggle: ["Toggle", "check"],
      remove: ["Delete", "trash-2"],
      edit: ["Edit", "pencil"],
      clearCompleted: ["Clear completed", "list-x"],
    });
  });

  it("outcome and new title are plain level fields; clearNewTitle empties the draft", () => {
    const m = createTodoListModel();
    m.view.setNewTitle("x");
    m.control.reportOutcome("add failed: disk full");
    expect(m.view.getOutcome()).toBe("add failed: disk full");
    m.control.clearNewTitle();
    m.control.reportOutcome(undefined);
    expect([m.view.getNewTitle(), m.view.getOutcome()]).toEqual(["", undefined]);
  });

  it("after dispose: mutators are no-ops, every action is disabled, reads return the last value", () => {
    const m = createTodoListModel();
    m.control.replaceItems(rows);
    m.view.select(["a"]);
    m.dispose();
    m.view.select(["b"]);
    m.control.replaceItems([]);
    m.view.actions.remove.submit();
    expect(m.view.getSelection()).toEqual(["a"]);
    expect(m.view.getItems()).toHaveLength(3);
    expect(m.control.actions.remove.getSubmits()).toBe(0);
    expect(m.view.actions.remove.getState().enabled).toBe(false);
  });
});
