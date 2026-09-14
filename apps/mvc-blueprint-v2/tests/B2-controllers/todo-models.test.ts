import { createConfirmDialogModel, createSampleOperation, createTodoListModel, type Todo } from "@todo/app";
import { describe, expect, it } from "vitest";

const todo = (id: string, title: string, done = false): Todo => ({ id, title, done });

/** Counts calls after subscribing — the immediate call is excluded. */
const watch = (subscribe: (l: () => void) => () => void) => {
  let n = -1;
  const off = subscribe(() => {
    n++;
  });
  return {
    get n() {
      return n;
    },
    off,
  };
};

describe("B2 · todo list model (signals)", () => {
  it("visible reads the flag even while the list is empty — showDone is a dependency from the start", () => {
    const m = createTodoListModel();
    const woken = watch(m.view.onVisibleUpdate);
    m.view.setShowDone(false);
    m.control.replaceTodos([todo("1", "done one", true)]);
    expect(m.view.getVisible(), "hidden by the flag").toEqual([]);
    expect(woken.n, "[] then [] is no change").toBe(0);
    m.view.setShowDone(true);
    expect(m.view.getVisible().map((t) => t.id)).toEqual(["1"]);
    expect(woken.n).toBe(1);
  });

  it("filters by the draft, case-insensitively", () => {
    const m = createTodoListModel();
    m.control.replaceTodos([todo("1", "Write the spec"), todo("2", "ship it")]);
    m.view.setFilter("WRITE");
    expect(m.view.getVisible().map((t) => t.id)).toEqual(["1"]);
  });

  it("the query group notifies once per change and keeps its identity across unrelated writes", () => {
    const m = createTodoListModel();
    const woken = watch(m.view.onQueryUpdate);
    const before = m.view.getQuery();
    m.control.reportOutcome("x");
    expect(m.view.getQuery()).toBe(before);
    m.view.setFilter("abc");
    expect(woken.n).toBe(1);
    expect(m.view.getQuery()).toEqual({ filterDraft: "abc", showDone: true });
  });

  it("every intent wakes the intent channel once, and drains return the batch", () => {
    const m = createTodoListModel();
    const woken = watch(m.control.onIntentUpdate);
    m.view.queueSubmit("a");
    m.view.requestToggle("1");
    m.view.requestRemove("2");
    m.view.requestClearCompleted();
    m.view.requestSampleTodos(3);
    expect(woken.n).toBe(5);
    expect(m.control.takePending()).toEqual([{ title: "a" }]);
    expect(m.control.takeToggles()).toEqual([{ id: "1" }]);
    expect(m.control.takeRemovals()).toEqual([{ id: "2" }]);
    expect(m.control.getClearCompletedCount()).toBe(1);
    expect(m.control.takeSampleRequests()).toEqual([3]);
  });

  it("a drain of an empty queue is silent", () => {
    const m = createTodoListModel();
    const woken = watch(m.control.onIntentUpdate);
    expect(m.control.takePending()).toEqual([]);
    expect(m.control.takeSampleRequests()).toEqual([]);
    expect(woken.n).toBe(0);
  });

  it("facets are frozen and the view carries no control member", () => {
    const m = createTodoListModel();
    expect(Object.isFrozen(m.view)).toBe(true);
    expect(Object.isFrozen(m.control)).toBe(true);
    expect(Object.keys(m.view).sort()).toEqual([
      "getOutcome",
      "getQuery",
      "getVisible",
      "onOutcomeUpdate",
      "onQueryUpdate",
      "onVisibleUpdate",
      "queueSubmit",
      "requestClearCompleted",
      "requestRemove",
      "requestSampleTodos",
      "requestToggle",
      "setFilter",
      "setShowDone",
    ]);
  });

  it("after dispose, mutators are no-ops", () => {
    const m = createTodoListModel();
    m.dispose();
    m.view.queueSubmit("late");
    m.control.replaceTodos([todo("1", "late")]);
    expect(m.control.takePending()).toEqual([]);
    expect(m.view.getVisible()).toEqual([]);
  });
});

describe("B2 · confirm dialog model (signals)", () => {
  it("the first answer wins, is announced once, and is taken once", () => {
    const d = createConfirmDialogModel("Clear 2 completed todos?");
    expect(d.view.getQuestion()).toBe("Clear 2 completed todos?");
    const woken = watch(d.control.onAnswerUpdate);
    expect(d.control.takeAnswer(), "nothing answered yet").toBeUndefined();
    d.view.answer(true);
    d.view.answer(false);
    expect(woken.n).toBe(1);
    expect(d.control.takeAnswer()).toBe(true);
    expect(d.control.takeAnswer(), "an answer is consumed once").toBeUndefined();
  });
});

describe("B2 · sample operation (signals)", () => {
  it("advances its progress, notifies per step, and stops at the total", () => {
    const op = createSampleOperation("Adding 2 sample todos", 2);
    const woken = watch(op.operation.onProgressUpdate);
    expect(op.operation.getProgress()).toEqual({ label: "Adding 2 sample todos", done: 0, total: 2 });
    op.advance();
    op.advance();
    op.advance();
    expect(op.operation.getProgress().done).toBe(2);
    expect(woken.n).toBe(2);
  });
});
