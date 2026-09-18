/**
 * The store contract — R1's replacement for the model contract (MODELS.md §4): notify once per
 * dispatch, stable snapshots, unsubscribe, dispose, late subscribers, commit order.
 */
import { describe, expect, it, vi } from "vitest";
import {
  afterSub,
  createLogger,
  createStore,
  definePoint,
  dispatchFx,
  type LogRecord,
  next,
  type Store,
} from "../../src/kernel/index.ts";

const make = () => {
  const logs: LogRecord[] = [];
  return { store: createStore(createLogger((r) => logs.push(r))), logs };
};
const counter = (store: Store, id = "c") =>
  store.addSlice<number>({
    id,
    init: () => 0,
    update: (n, msg) =>
      msg.type === "inc"
        ? n + 1
        : msg.type === "twice"
          ? next(n + 1, dispatchFx({ type: "inc" }))
          : n,
  });
const point = definePoint<number>("p");

describe("store contract", () => {
  it("notifies once per dispatch that changes state, never for a no-op", () => {
    const { store } = make();
    counter(store);
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ type: "inc" });
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispatch({ type: "nothing" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a message dispatched as an effect is its own step: one more notification, after the first", () => {
    const { store } = make();
    counter(store);
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.getState().c));
    store.dispatch({ type: "twice" });
    expect(seen).toEqual([1, 2]);
  });

  it("snapshots are stable: same object between dispatches; untouched slices keep identity", () => {
    const { store } = make();
    counter(store, "a");
    store.addSlice({ id: "b", init: () => ({ list: [1] }), update: (s) => s });
    const s1 = store.getState();
    expect(store.getState()).toBe(s1);
    store.dispatch({ type: "inc" });
    const s2 = store.getState();
    expect(s2).not.toBe(s1);
    expect(s2.b).toBe(s1.b);
    expect(Object.isFrozen(s2) && Object.isFrozen(s2.b)).toBe(true);
  });

  it("select is memoised per state: stable arrays for useSyncExternalStore", () => {
    const { store } = make();
    const c = counter(store);
    c.contribute(point, "x", (n) => [n]);
    const a = store.select(point);
    expect(store.select(point)).toBe(a);
    store.dispatch({ type: "inc" });
    expect(store.select(point)).toEqual([1]);
    expect(store.select(point)).not.toBe(a);
  });

  it("dispatch inside a listener is queued, not re-entrant", () => {
    const { store } = make();
    counter(store);
    const seen: number[] = [];
    store.subscribe(() => {
      const n = store.getState().c as number;
      seen.push(n);
      if (n === 1) store.dispatch({ type: "inc" });
    });
    store.dispatch({ type: "inc" });
    expect(seen).toEqual([1, 2]);
  });

  it("unsubscribe stops notifications, also when done during a notification", () => {
    const { store } = make();
    counter(store);
    const second = vi.fn();
    const off1 = store.subscribe(() => off2());
    const off2 = store.subscribe(second);
    store.dispatch({ type: "inc" }); // listeners are snapshotted per notify: second still runs once
    store.dispatch({ type: "inc" });
    expect(second).toHaveBeenCalledTimes(1);
    off1();
  });

  it("a late subscriber reads the current state and derivations at once", () => {
    const { store } = make();
    const c = counter(store);
    c.contribute(point, "x", (n) => [n]);
    store.dispatch({ type: "inc" });
    store.dispatch({ type: "inc" });
    expect(store.select(point)).toEqual([2]); // no replay needed: state is retained
  });

  it("a derivation contributed before its source slice sees it when the slice arrives", () => {
    const { store } = make();
    const source = definePoint<number>("source");
    store.contribute(point, "consumer", (select) => select(source).map((n) => n * 10));
    expect(store.select(point)).toEqual([]);
    const c = counter(store);
    c.contribute(source, "owner", (n) => [n]);
    store.dispatch({ type: "inc" });
    expect(store.select(point)).toEqual([10]);
  });

  it("a throwing update or derivation is logged and contained", () => {
    const { store, logs } = make();
    counter(store);
    store.addSlice({
      id: "bad",
      init: () => 0,
      update: () => {
        throw new Error("boom");
      },
    });
    store.contribute(point, "bad", () => {
      throw new Error("boom");
    });
    store.dispatch({ type: "inc" });
    expect(store.getState().c).toBe(1);
    expect(store.select(point)).toEqual([]);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(2);
  });

  it("detects derivation cycles loudly", () => {
    const { store } = make();
    const q = definePoint<number>("q");
    store.contribute(point, "a", (select) => select(q));
    store.contribute(q, "b", (select) => select(point));
    expect(() => store.select(point)).toThrow(/cycle/);
  });

  it("fails loudly on wiring mistakes: second writer, duplicate contribution, duplicate handler, missing handler", () => {
    const { store, logs } = make();
    counter(store);
    expect(() => counter(store)).toThrow(/already has a writer/);
    store.contribute(point, "k", () => []);
    expect(() => store.contribute(point, "k", () => [])).toThrow(/already has a contribution/);
    store.addEffectHandler("fx", () => {});
    expect(() => store.addEffectHandler("fx", () => {})).toThrow(/already has a handler/);
    store.addSlice({
      id: "e",
      init: () => 0,
      update: (s, m) => (m.type === "go" ? next(s, { type: "nobody" }) : s),
    });
    store.dispatch({ type: "go" });
    expect(
      logs.some((l) => l.level === "error" && /no handler for effect nobody/.test(l.message)),
    ).toBe(true);
    expect(store.coverage().unhandledEffects).toEqual(["nobody"]);
  });

  it("records messages no update acted on (coverage), without an error", () => {
    const { store, logs } = make();
    counter(store);
    store.dispatch({ type: "todos/compose" });
    expect(store.coverage().idleMessages).toEqual(["todos/compose"]);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("subscriptions are diffed by key: started once, stopped when they leave the state", async () => {
    vi.useFakeTimers();
    try {
      const { store } = make();
      store.addSlice<{ items: string[] }>({
        id: "t",
        init: () => ({ items: [] }),
        update: (s, m) =>
          m.type === "add" ? { items: [...s.items, "x"] } : m.type === "gone" ? { items: [] } : s,
        subscriptions: (s) => s.items.map((i) => afterSub(i, 100, { type: "gone" })),
      });
      store.dispatch({ type: "add" });
      store.dispatch({ type: "add" }); // same key "x": not restarted
      expect(store.inspect().subscriptions).toBe(1);
      vi.advanceTimersByTime(100);
      expect(store.getState().t).toEqual({ items: [] });
      expect(store.inspect().subscriptions).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dispose", () => {
  it("removing a slice deletes its key, aborts its effects and drops their late dispatches", async () => {
    const { store, logs } = make();
    let release!: () => void;
    let signal!: AbortSignal;
    store.addEffectHandler<{ type: "slow" }>("slow", async (_fx, io) => {
      signal = io.signal;
      await new Promise<void>((r) => (release = r));
      io.dispatch({ type: "late" });
    });
    const h = store.addSlice<string>({
      id: "s",
      init: () => "idle",
      update: (s, m) =>
        m.type === "go" ? next("busy", { type: "slow" }) : m.type === "late" ? "written" : s,
    });
    const other = vi.fn((s: number) => s);
    store.addSlice<number>({
      id: "o",
      init: () => 0,
      update: (s, m) => (m.type === "late" ? other(s) + 1 : s),
    });
    store.dispatch({ type: "go" });
    expect(store.inspect().effectsInFlight).toBe(1);
    h.dispose();
    expect(signal.aborted).toBe(true);
    expect("s" in store.getState()).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().o).toBe(0); // the late message never reached anyone
    expect(logs.some((l) => /dropped late/.test(l.message))).toBe(true);
  });

  it("store.dispose empties everything and ignores later dispatches", () => {
    const { store } = make();
    counter(store).contribute(point, "x", (n) => [n]);
    store.subscribe(() => {});
    store.dispose();
    store.dispatch({ type: "inc" });
    expect(store.inspect()).toEqual({
      slices: [],
      contributions: 0,
      effectHandlers: 0,
      effectsInFlight: 0,
      subscriptions: 0,
      listeners: 0,
    });
  });
});
