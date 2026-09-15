import { createTodoListModel, expectReplacedNotMutated, type TodoListModel } from "@todo/app";
import { describe, expect, it } from "vitest";
import { watch } from "../support/signals.js";

/**
 * B1 · the todo model. Change is counted at the source (`watch`, an effect on
 * the read) — never through something downstream that dedups on its own.
 */
describe("B1 · todo model", () => {
  it("derives the visible set from the level fields, without storing it", () => {
    const m = createTodoListModel();
    m.control.replaceTodos([
      { id: "1", title: "write", done: false },
      { id: "2", title: "ship", done: true },
    ]);
    m.view.setShowDone(false);
    expect(m.view.visible().map((t) => t.id)).toEqual(["1"]);
    m.view.setShowDone(true);
    expect(m.view.visible().map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("filters by the draft, case-insensitively", () => {
    const m = createTodoListModel();
    m.control.replaceTodos([
      { id: "1", title: "Write the spec", done: false },
      { id: "2", title: "ship it", done: false },
    ]);
    m.view.setFilter("WRITE");
    expect(m.view.visible().map((t) => t.id)).toEqual(["1"]);
  });

  it("visible is tracked through BOTH query halves and the list — no forwarding (parent D16)", () => {
    const m = createTodoListModel();
    const woken = watch(m.view.visible);
    m.view.setShowDone(false);
    expect(woken.n, "showDone alone").toBe(1);
    m.view.setFilter("abc");
    expect(woken.n, "filterDraft alone").toBe(2);
    m.view.setFilter("abc");
    expect(woken.n, "no query change, no wake").toBe(2);
    m.control.replaceTodos([]);
    expect(woken.n, "the list").toBe(3);
  });

  it("visible derives from nothing on the add form or the row queues", () => {
    const m = createTodoListModel();
    const woken = watch(m.view.visible);
    m.view.queueSubmit("a");
    m.control.takePending();
    m.view.requestToggle("1");
    m.view.requestRemove("1");
    m.view.requestClearCompleted();
    m.view.requestRefresh();
    expect(woken.n).toBe(0);
  });

  it("replaces the todo list rather than mutating it", async () => {
    const m = createTodoListModel();
    await expectReplacedNotMutated(m.control.todos, () => {
      m.control.replaceTodos([...m.control.todos(), { id: "1", title: "x", done: false }]);
    });
  });

  it("keeps the event-edge queue replaced, so a drain is observable", async () => {
    const m = createTodoListModel();
    m.view.queueSubmit("a");
    await expectReplacedNotMutated(m.control.edges.pending, () => {
      m.control.takePending();
    });
  });

  for (const [name, write, read] of [
    ["setFilter", (m: TodoListModel) => m.view.setFilter("abc"), (m: TodoListModel) => m.view.filterDraft],
    ["setShowDone", (m: TodoListModel) => m.view.setShowDone(false), (m: TodoListModel) => m.view.showDone],
    ["reportOutcome", (m: TodoListModel) => m.control.reportOutcome("x"), (m: TodoListModel) => m.view.lastOutcome],
  ] as const) {
    it(`${name}: a write of the value already held wakes nobody`, () => {
      const m = createTodoListModel();
      const woken = watch(read(m));
      write(m);
      write(m);
      write(m);
      expect(woken.n, "three writes, one real change").toBe(1);
    });
  }

  it("reportOutcome: clearing twice is one change too", () => {
    const m = createTodoListModel();
    m.control.reportOutcome("x");
    const woken = watch(m.view.lastOutcome);
    m.control.reportOutcome(undefined);
    m.control.reportOutcome(undefined);
    expect(woken.n).toBe(1);
  });

  it("takePending on an empty queue is silent", () => {
    const m = createTodoListModel();
    m.view.queueSubmit("a");
    expect(m.control.takePending()).toEqual([{ title: "a" }]);
    const woken = watch(m.control.edges.pending);
    expect(m.control.takePending()).toEqual([]);
    expect(woken.n, "draining an empty queue is not a change").toBe(0);
  });

  it("wakes a watcher of one edge only for its own change", () => {
    const m = createTodoListModel();
    const refreshes = watch(m.control.edges.refreshCount);
    const filters = watch(m.view.filterDraft);
    m.view.setFilter("abc");
    expect([refreshes.n, filters.n], "a filter change does not wake refresh").toEqual([0, 1]);
    m.view.requestRefresh();
    expect([refreshes.n, filters.n], "a refresh does not wake the filter").toEqual([1, 1]);
  });

  it("an equal-content replacement is still a change — change detection is by identity", () => {
    const m = createTodoListModel();
    const woken = watch(m.control.todos);
    m.control.replaceTodos([{ id: "1", title: "x", done: false }]);
    m.control.replaceTodos([{ id: "1", title: "x", done: false }]);
    expect(woken.n).toBe(2);
  });
});

/**
 * The facets are what keeps a view off the controller's side (spec §4.3). B0
 * checks names in the view layer's source; these check the objects.
 */
describe("B1 · the two facets", () => {
  const VIEW_KEYS = [
    "filterDraft",
    "lastOutcome",
    "queueSubmit",
    "requestClearCompleted",
    "requestRefresh",
    "requestRemove",
    "requestToggle",
    "setFilter",
    "setShowDone",
    "showDone",
    "visible",
  ];
  const CONTROL_KEYS = ["edges", "replaceTodos", "reportOutcome", "takePending", "takeRemovals", "takeToggles", "todos"];
  const EDGE_KEYS = ["clearCompletedCount", "pending", "refreshCount", "removals", "toggles"];

  it("carry exactly the members the spec lists — adding one is a deliberate edit here", () => {
    const m = createTodoListModel();
    expect(Object.keys(m).sort()).toEqual(["control", "view"]);
    expect(Object.keys(m.view).sort()).toEqual(VIEW_KEYS);
    expect(Object.keys(m.control).sort()).toEqual(CONTROL_KEYS);
    expect(Object.keys(m.control.edges).sort()).toEqual(EDGE_KEYS);
  });

  it("are frozen — a facet is shared, so replacing one of its functions would change it for every holder", () => {
    const m = createTodoListModel();
    for (const facet of [m, m.view, m.control, m.control.edges]) {
      expect(Object.isFrozen(facet)).toBe(true);
    }
  });

  it("share no function — nothing the view holds is a controller-side capability", () => {
    const m = createTodoListModel();
    const fns = (o: object) => new Set(Object.values(o).filter((v) => typeof v === "function"));
    const viewFns = fns(m.view);
    for (const fn of [...fns(m.control), ...fns(m.control.edges)]) {
      expect(viewFns.has(fn)).toBe(false);
    }
  });

  it("hand out reads that cannot write — calling one with an argument changes nothing", () => {
    const m = createTodoListModel();
    m.control.replaceTodos([{ id: "1", title: "x", done: false }]);
    const tryWrite = (read: unknown, value: unknown) => (read as (v: unknown) => void)(value);
    tryWrite(m.view.filterDraft, "hacked");
    tryWrite(m.view.showDone, false);
    tryWrite(m.view.lastOutcome, "hacked");
    tryWrite(m.view.visible, []);
    tryWrite(m.control.todos, []);
    tryWrite(m.control.edges.pending, [{ title: "hacked" }]);
    expect(m.view.filterDraft()).toBe("");
    expect(m.view.showDone()).toBe(true);
    expect(m.view.lastOutcome()).toBeUndefined();
    expect(m.view.visible()).toHaveLength(1);
    expect(m.control.todos()).toHaveLength(1);
    expect(m.control.edges.pending()).toEqual([]);
  });
});

/**
 * The row intents a view raises. Two are EVENT edges carrying their payload
 * (replaced queues); one is a STATE-LATEST edge (a counter).
 */
describe("B1 · row intents", () => {
  const queues = [
    {
      name: "toggle",
      raise: (m: TodoListModel, id: string) => m.view.requestToggle(id),
      take: (m: TodoListModel) => m.control.takeToggles(),
      read: (m: TodoListModel) => m.control.edges.toggles,
    },
    {
      name: "remove",
      raise: (m: TodoListModel, id: string) => m.view.requestRemove(id),
      take: (m: TodoListModel) => m.control.takeRemovals(),
      read: (m: TodoListModel) => m.control.edges.removals,
    },
  ] as const;

  for (const q of queues) {
    describe(`the ${q.name} queue — an EVENT edge`, () => {
      it("queues the id, one change per request", () => {
        const m = createTodoListModel();
        const woken = watch(q.read(m));
        q.raise(m, "1");
        q.raise(m, "2");
        expect(q.read(m)()).toEqual([{ id: "1" }, { id: "2" }]);
        expect(woken.n, "one intention, one change").toBe(2);
      });

      it("honours a repeated id — two presses on one row are two actions", () => {
        const m = createTodoListModel();
        q.raise(m, "1");
        q.raise(m, "1");
        expect(q.read(m)()).toEqual([{ id: "1" }, { id: "1" }]);
      });

      it("is replaced on request, never mutated", async () => {
        const m = createTodoListModel();
        await expectReplacedNotMutated(q.read(m), () => {
          q.raise(m, "1");
        });
      });

      it("drains by replacement and hands the batch back", async () => {
        const m = createTodoListModel();
        q.raise(m, "1");
        q.raise(m, "2");
        const before = q.read(m)();
        let batch: readonly { id: string }[] = [];
        await expectReplacedNotMutated(q.read(m), () => {
          batch = q.take(m);
        });
        expect(batch).toEqual([{ id: "1" }, { id: "2" }]);
        expect(q.read(m)()).toEqual([]);
        expect(before, "the batch was handed back, not emptied in place").toEqual([{ id: "1" }, { id: "2" }]);
      });

      it("is silent when drained empty", () => {
        const m = createTodoListModel();
        q.raise(m, "1");
        q.take(m);
        const woken = watch(q.read(m));
        expect(q.take(m)).toEqual([]);
        expect(q.take(m)).toEqual([]);
        expect(woken.n).toBe(0);
      });
    });
  }

  it("clear-completed raises a monotonic counter, one change per request", () => {
    const m = createTodoListModel();
    const woken = watch(m.control.edges.clearCompletedCount);
    m.view.requestClearCompleted();
    m.view.requestClearCompleted();
    expect(m.control.edges.clearCompletedCount(), "coalescing is the controller's job").toBe(2);
    expect(woken.n).toBe(2);
  });

  it("each intent wakes only its own edge", () => {
    const m = createTodoListModel();
    const reads = {
      toggles: m.control.edges.toggles,
      removals: m.control.edges.removals,
      clearCompletedCount: m.control.edges.clearCompletedCount,
      pending: m.control.edges.pending,
      refreshCount: m.control.edges.refreshCount,
      query: () => [m.view.filterDraft(), m.view.showDone()],
    };
    const watchers = Object.fromEntries(Object.entries(reads).map(([k, r]) => [k, watch(r)]));
    const counts = () => Object.fromEntries(Object.entries(watchers).map(([k, w]) => [k, w.n]));
    let last = counts();
    const expectOnly = (owner: string, label: string) => {
      const now = counts();
      const delta = Object.fromEntries(Object.keys(now).map((k) => [k, now[k] - last[k]]));
      expect(delta, label).toEqual(Object.fromEntries(Object.keys(now).map((k) => [k, k === owner ? 1 : 0])));
      last = now;
    };
    m.view.requestToggle("1");
    expectOnly("toggles", "requestToggle");
    m.control.takeToggles();
    expectOnly("toggles", "takeToggles");
    m.view.requestRemove("1");
    expectOnly("removals", "requestRemove");
    m.control.takeRemovals();
    expectOnly("removals", "takeRemovals");
    m.view.requestClearCompleted();
    expectOnly("clearCompletedCount", "requestClearCompleted");
    m.view.queueSubmit("a");
    expectOnly("pending", "queueSubmit");
    m.view.requestRefresh();
    expectOnly("refreshCount", "requestRefresh");
    m.view.setFilter("x");
    expectOnly("query", "setFilter");
  });
});
