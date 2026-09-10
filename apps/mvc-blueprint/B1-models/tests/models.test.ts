import { describe, expect, it } from "vitest";
import { TodoListModel, expectReplacedNotMutated } from "@todo/app";

describe("B1 · todo models", () => {
  it("derives the visible set from level fields, without storing it", () => {
    const m = new TodoListModel();
    m.replaceTodos([
      { id: "1", title: "write", done: false },
      { id: "2", title: "ship", done: true },
    ]);
    m.input.setShowDone(false);
    expect(m.visible().map((t) => t.id)).toEqual(["1"]);
    m.input.setShowDone(true);
    expect(m.visible().map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("filters by the draft, case-insensitively", () => {
    const m = new TodoListModel();
    m.replaceTodos([
      { id: "1", title: "Write the spec", done: false },
      { id: "2", title: "ship it", done: false },
    ]);
    m.input.setFilter("WRITE");
    expect(m.visible().map((t) => t.id)).toEqual(["1"]);
  });

  it("replaces the todo list rather than mutating it", async () => {
    const m = new TodoListModel();
    await expectReplacedNotMutated(m, () => m.todos, () => {
      m.replaceTodos([...m.todos, { id: "1", title: "x", done: false }]);
    });
  });

  it("keeps the event-edge queue replaced, so a drain is observable", async () => {
    const m = new TodoListModel();
    m.input.queueSubmit("a");
    await expectReplacedNotMutated(m.input, () => m.input.pending, () => {
      m.input.takePending();
    });
  });

  it("raises no notify when a mutator is handed the value it already holds", () => {
    // Spec §4.11: this is what kills a self-wake cycle at SOURCE — no notify is
    // raised, so nothing anywhere needs suppressing, and it survives an await
    // because it is a property of the write, not of the call stack.
    const m = new TodoListModel();
    let queries = 0;
    m.input.onQueryChange(() => { queries++; });
    m.input.setFilter("abc");
    m.input.setFilter("abc");
    m.input.setFilter("abc");
    expect(queries, "three writes, one real change").toBe(1);
  });

  it("wakes a channel subscriber only for its own change", () => {
    const m = new TodoListModel();
    let refreshes = 0;
    let queries = 0;
    m.input.onRefresh(() => { refreshes++; });
    m.input.onQueryChange(() => { queries++; });

    m.input.setFilter("abc");
    expect([refreshes, queries], "a filter change must not wake onRefresh").toEqual([0, 1]);

    m.input.requestRefresh();
    expect([refreshes, queries], "a refresh must not wake onQueryChange").toEqual([1, 1]);
  });

  it("keeps a channel alive across replacement, which is why arrays are replaced", () => {
    const m = new TodoListModel();
    let changes = 0;
    m.onTodosChange(() => { changes++; });
    m.replaceTodos([{ id: "1", title: "x", done: false }]);
    expect(changes).toBe(1);
    // Same contents, new array identity: the channel fires, because a selector
    // comparing by identity is what the view uses too.
    m.replaceTodos([{ id: "1", title: "x", done: false }]);
    expect(changes).toBe(2);
  });

  it("drops underscore-prefixed fields from toJSON, so a session snapshot is clean", () => {
    const m = new TodoListModel();
    m.replaceTodos([{ id: "1", title: "x", done: false }]);
    const json = JSON.parse(JSON.stringify(m.toJSON()));
    expect(json.todos).toHaveLength(1);
    expect(Object.keys(json)).not.toContain("_handled");
    // Channels are function-valued, so toJSON skips them — a snapshot stays data.
    expect(Object.keys(json)).not.toContain("onTodosChange");
  });
});
