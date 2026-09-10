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
    // Counted on the RAW notify channel, deliberately: subscribing through a
    // named channel would prove onChangeNotifier's dedup instead of the
    // mutator's guard, and would pass with the guard deleted.
    const m = new TodoListModel();
    let notifies = 0;
    m.input.onUpdate(() => { notifies++; });
    m.input.setFilter("abc");
    m.input.setFilter("abc");
    m.input.setFilter("abc");
    expect(notifies, "three writes, one real change").toBe(1);
  });

  it("does not notify when takePending drains an already-empty queue", () => {
    const m = new TodoListModel();
    m.input.queueSubmit("a");
    expect(m.input.takePending()).toEqual([{ title: "a" }]);

    let notifies = 0;
    m.input.onUpdate(() => { notifies++; });
    expect(m.input.takePending()).toEqual([]);
    expect(notifies, "draining an empty queue is not a field change").toBe(0);
  });

  it("wakes onPendingChange when a submission is queued", () => {
    const m = new TodoListModel();
    let changes = 0;
    m.input.onPendingChange(() => { changes++; });
    m.input.queueSubmit("a");
    expect(changes).toBe(1);
  });

  it("raises no notify when reportOutcome is handed the outcome it already holds", () => {
    // Counted on the RAW notify channel, exactly as for setFilter above.
    // Subscribing through onOutcomeChange would prove onChangeNotifier's own
    // dedup, and pass with reportOutcome's compare-before-write guard deleted
    // (which it did).
    const m = new TodoListModel();
    let notifies = 0;
    m.onUpdate(() => { notifies++; });
    m.reportOutcome("x");
    m.reportOutcome("x");
    m.reportOutcome("x");
    expect(notifies, "three writes, one real change").toBe(1);
    m.reportOutcome(undefined);
    m.reportOutcome(undefined);
    expect(notifies, "clearing twice is one change too").toBe(2);
  });

  it("wakes onOutcomeChange when the outcome changes", () => {
    const m = new TodoListModel();
    let changes = 0;
    m.onOutcomeChange(() => { changes++; });
    m.reportOutcome("x");
    m.reportOutcome("y");
    expect(changes).toBe(2);
  });

  it("wakes onQueryChange from either half of the composite selector", () => {
    const m = new TodoListModel();
    let queries = 0;
    m.input.onQueryChange(() => { queries++; });
    m.input.setShowDone(false);
    expect(queries, "showDone is half of the composite query").toBe(1);
    m.input.setFilter("abc");
    expect(queries, "filterDraft is the other half").toBe(2);
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

  it("keeps change channels out of toJSON, so a session snapshot stays data", () => {
    // Spec §4.10 property 3: channels are function-valued fields, and toJSON
    // skips functions. (No model here has an underscore field, so this test no
    // longer claims to check one.)
    const m = new TodoListModel();
    m.replaceTodos([{ id: "1", title: "x", done: false }]);
    const json = JSON.parse(JSON.stringify(m.toJSON()));
    expect(json.todos).toHaveLength(1);
    for (const channel of ["onTodosChange", "onOutcomeChange", "onUpdate"]) {
      expect(Object.keys(json), `${channel} is a function, not state`).not.toContain(channel);
    }
    const input = JSON.parse(JSON.stringify(m.input.toJSON()));
    for (const channel of ["onRefresh", "onPendingChange", "onQueryChange"]) {
      expect(Object.keys(input), `${channel} is a function, not state`).not.toContain(channel);
    }
  });
});

/**
 * The row intents a view needs (Task 13a): every button a view can press must
 * exist as a mutator on the INPUT sub-model, because a view knows only models.
 * Two are EVENT edges carrying their payload (a replaced queue, like
 * `pending`); one is a STATE-LATEST edge (a counter, like `refreshCount`).
 *
 * Notifies are counted on the RAW `onUpdate`, never through the named channel:
 * a channel's own `!==` dedup would hide a missing compare-before-write guard,
 * which is the mistake this codebase has already made and fixed three times.
 */
describe("B1 · row intents on the input sub-model", () => {
  const rawNotifies = (m: TodoListModel) => {
    const counter = { n: 0 };
    m.input.onUpdate(() => {
      counter.n++;
    });
    return counter;
  };

  // The two queues share one shape; each is tested through the same table so a
  // guard missing from ONE of them cannot hide behind the other's test.
  const queues = [
    {
      name: "toggle",
      raise: (m: TodoListModel, id: string) => m.input.requestToggle(id),
      take: (m: TodoListModel) => m.input.takeToggles(),
      read: (m: TodoListModel) => m.input.toggles,
    },
    {
      name: "remove",
      raise: (m: TodoListModel, id: string) => m.input.requestRemove(id),
      take: (m: TodoListModel) => m.input.takeRemovals(),
      read: (m: TodoListModel) => m.input.removals,
    },
  ] as const;

  for (const q of queues) {
    describe(`the ${q.name} queue — an EVENT edge`, () => {
      it("queues the id with ONE raw notify per request", () => {
        const m = new TodoListModel();
        const raw = rawNotifies(m);
        q.raise(m, "1");
        q.raise(m, "2");
        expect(q.read(m)).toEqual([{ id: "1" }, { id: "2" }]);
        expect(raw.n, "one intention, one notify").toBe(2);
      });

      it("honours a repeated id — two presses on one row are two actions, not one", () => {
        // An event edge is never deduplicated: toggling a row twice is a
        // round trip the user asked for, and a queue that collapsed it would
        // silently drop one of them.
        const m = new TodoListModel();
        const raw = rawNotifies(m);
        q.raise(m, "1");
        q.raise(m, "1");
        expect(q.read(m)).toEqual([{ id: "1" }, { id: "1" }]);
        expect(raw.n).toBe(2);
      });

      it("is replaced on request, never mutated — so its channel can see it", async () => {
        const m = new TodoListModel();
        await expectReplacedNotMutated(m.input, () => q.read(m), () => {
          q.raise(m, "1");
        });
      });

      it("drains by replacement and hands the batch back", async () => {
        const m = new TodoListModel();
        q.raise(m, "1");
        q.raise(m, "2");
        const before = q.read(m);
        let batch: readonly { id: string }[] = [];
        await expectReplacedNotMutated(m.input, () => q.read(m), () => {
          batch = q.take(m);
        });
        expect(batch).toEqual([{ id: "1" }, { id: "2" }]);
        expect(q.read(m)).toEqual([]);
        expect(before, "the drained batch was handed back, not emptied in place").toEqual([
          { id: "1" },
          { id: "2" },
        ]);
      });

      it("is silent when drained empty — counted on the RAW notify", () => {
        const m = new TodoListModel();
        q.raise(m, "1");
        q.take(m);
        const raw = rawNotifies(m);
        expect(q.take(m)).toEqual([]);
        expect(q.take(m)).toEqual([]);
        expect(raw.n, "draining an empty queue is not a field change").toBe(0);
      });
    });
  }

  describe("clear-completed — a STATE-LATEST edge", () => {
    it("raises a monotonic counter, one raw notify per request", () => {
      const m = new TodoListModel();
      const raw = rawNotifies(m);
      expect(m.input.clearCompletedCount).toBe(0);
      m.input.requestClearCompleted();
      m.input.requestClearCompleted();
      expect(m.input.clearCompletedCount, "every press is counted; coalescing is the controller's job").toBe(2);
      expect(raw.n).toBe(2);
    });
  });

  it("wakes each channel only for its own change", () => {
    // Every intent against every channel. A channel woken by a neighbour's
    // mutator would wake a controller for work it does not own.
    const m = new TodoListModel();
    const woken: Record<string, number> = {};
    const channels = {
      onTogglesChange: m.input.onTogglesChange,
      onRemovalsChange: m.input.onRemovalsChange,
      onClearCompleted: m.input.onClearCompleted,
      onPendingChange: m.input.onPendingChange,
      onRefresh: m.input.onRefresh,
      onQueryChange: m.input.onQueryChange,
    };
    for (const [name, channel] of Object.entries(channels)) {
      woken[name] = 0;
      channel(() => {
        woken[name]++;
      });
    }
    const expectOnly = (owner: string, label: string) => {
      const expected = Object.fromEntries(Object.keys(channels).map((k) => [k, k === owner ? 1 : 0]));
      expect(woken, label).toEqual(expected);
      for (const k of Object.keys(woken)) woken[k] = 0;
    };

    m.input.requestToggle("1");
    expectOnly("onTogglesChange", "requestToggle");
    m.input.takeToggles();
    expectOnly("onTogglesChange", "takeToggles");
    m.input.requestRemove("1");
    expectOnly("onRemovalsChange", "requestRemove");
    m.input.takeRemovals();
    expectOnly("onRemovalsChange", "takeRemovals");
    m.input.requestClearCompleted();
    expectOnly("onClearCompleted", "requestClearCompleted");
    m.input.queueSubmit("a");
    expectOnly("onPendingChange", "queueSubmit");
    m.input.requestRefresh();
    expectOnly("onRefresh", "requestRefresh");
    m.input.setFilter("x");
    expectOnly("onQueryChange", "setFilter");
  });

  it("keeps the new channels out of toJSON", () => {
    const m = new TodoListModel();
    m.input.requestToggle("1");
    const input = JSON.parse(JSON.stringify(m.input.toJSON()));
    expect(input.toggles).toEqual([{ id: "1" }]);
    for (const channel of ["onTogglesChange", "onRemovalsChange", "onClearCompleted"]) {
      expect(Object.keys(input), `${channel} is a function, not state`).not.toContain(channel);
    }
  });
});
