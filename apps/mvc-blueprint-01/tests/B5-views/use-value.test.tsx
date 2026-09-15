import { createTodoListModel, type Todo } from "@todo/app/models";
import { shallowEqual, useValue } from "@todo/ui";
import { Component, createElement, type ReactNode, useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { flush, render, waitFor } from "../support/react.js";

/**
 * B5 — the whole React binding, over a real Chromium, on the signals contract
 * alone. `useValue(read, isEqual)` subscribes with an effect over `read` and
 * snapshots `untracked(read)`, caching the last value for the same `read`
 * while `isEqual` holds.
 */

let view: ReturnType<typeof render> | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const mount = async (element: ReturnType<typeof createElement>, values: unknown[]) => {
  view = render(element);
  await waitFor(() => values.length >= 1);
};

const todo = (id: string, title: string, done = false): Todo => ({ id, title, done });

/** Renders nothing; records every value `useValue` hands it, once per commit. */
function Probe<T>({ read, isEqual, values }: { read: () => T; isEqual?: (a: T, b: T) => boolean; values: T[] }) {
  const value = useValue(read, isEqual);
  useLayoutEffect(() => {
    values.push(value);
  });
  return null;
}

describe("useValue", () => {
  it("re-renders when the read value changes, driven by a mutator", async () => {
    const model = createTodoListModel();
    const values: (string | undefined)[] = [];
    await mount(createElement(Probe, { read: model.view.lastOutcome, values }), values);
    expect(values).toEqual([undefined]);

    model.control.reportOutcome("could not reach the store");
    await waitFor(() => values.length >= 2);
    expect(values).toEqual([undefined, "could not reach the store"]);
  });

  it("does not re-render when a signal it does not read changes", async () => {
    // Counted at the source, as "unsubscribes on unmount" below does: `values`
    // not changing is no evidence on its own — `lastOutcome` never changes in
    // this test either way, so React's own snapshot check (same `undefined`
    // reference) would bail out however often the subscription woke, even for
    // a `read` that spuriously tracked `todos` too. Only the read count can
    // tell the difference.
    const model = createTodoListModel();
    let reads = 0;
    const read = () => {
      reads++;
      return model.view.lastOutcome();
    };
    const values: (string | undefined)[] = [];
    await mount(createElement(Probe, { read, values }), values);

    // A benign write first, proving the subscription is live — same shape as
    // "unsubscribes on unmount": with no evidence the subscription ever ran,
    // the read count not moving after `replaceTodos` would prove nothing.
    model.control.reportOutcome("ok");
    await waitFor(() => values.length >= 2);
    const atSubscribed = reads;

    model.control.replaceTodos([todo("1", "buy milk")]);
    await flush();
    await flush();
    await flush();
    expect(values, "no re-render happened").toEqual([undefined, "ok"]);
    expect(reads, "a subscription that also tracked todos would have re-read").toBe(atSubscribed);
  });

  it("a derived array with shallowEqual re-renders only when the contents change", async () => {
    const model = createTodoListModel();
    const a = todo("1", "buy milk");
    const b = todo("2", "walk dog");
    model.control.replaceTodos([a, b]);

    const values: Todo[][] = [];
    await mount(createElement(Probe, { read: model.view.visible, isEqual: shallowEqual, values }), values);
    expect(values).toEqual([[a, b]]);

    // A new array at `todos` recomputes `visible` into a new array — equal contents.
    model.control.replaceTodos([a, b]);
    await flush();
    await flush();
    expect(values).toHaveLength(1);

    const c = todo("3", "read book");
    model.control.replaceTodos([a, b, c]);
    await waitFor(() => values.length >= 2);
    expect(values[1]).toEqual([a, b, c]);
  });

  it("REGRESSION: re-pointed at another model, it samples the new one even when isEqual would call them equal", async () => {
    // Keyed by the read as well as the value: a value-only cache would hand
    // back modelA's empty array for modelB's, equal under shallowEqual.
    const modelA = createTodoListModel();
    const modelB = createTodoListModel();
    const values: Todo[][] = [];
    await mount(createElement(Probe, { read: modelA.view.visible, isEqual: shallowEqual, values }), values);
    const cachedFromA = values[0];

    view!.root.render(createElement(Probe, { read: modelB.view.visible, isEqual: shallowEqual, values }));
    await waitFor(() => values.length >= 2);
    expect(values[1]).not.toBe(cachedFromA);
    expect(values[1]).toBe(modelB.view.visible());

    modelB.control.replaceTodos([todo("1", "buy milk")]);
    await waitFor(() => values.length >= 3);
    expect(values[2]).toEqual([todo("1", "buy milk")]);
  });

  it("PROVES the comparator is load-bearing: a read returning a fresh array, compared with Object.is, trips React's loop guard", async () => {
    const model = createTodoListModel();
    model.control.replaceTodos([todo("1", "buy milk"), todo("2", "walk dog")]);
    // `visible` itself is a computed and returns a stable reference; this read
    // copies it, which is the shape an inline derivation has.
    const freshEveryCall = () => [...model.view.visible()];

    const consoleErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
    const windowErrors: unknown[] = [];
    const onWindowError = (event: ErrorEvent) => {
      windowErrors.push(event.error ?? event.message);
      event.preventDefault();
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      windowErrors.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);

    let thrown: unknown;
    try {
      const values: Todo[][] = [];
      view = render(createElement(Probe, { read: freshEveryCall, values }));
      for (let i = 0; i < 20; i++) await flush();
    } catch (error) {
      thrown = error;
    } finally {
      console.error = originalConsoleError;
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onRejection);
    }

    const haystack = [thrown, ...windowErrors, ...consoleErrors.flat()]
      .map((v) => (v instanceof Error ? `${v.message}\n${v.stack ?? ""}` : String(v)))
      .join("\n");
    const sawLoopGuard =
      /getSnapshot should be cached/i.test(haystack) ||
      /Maximum update depth exceeded/i.test(haystack) ||
      /Too many re-renders/i.test(haystack);
    expect(sawLoopGuard, `expected React's getSnapshot-loop guard; captured:\n${haystack || "(nothing)"}`).toBe(true);
  });

  it("a read may close over props: re-rendered with a new prop, it re-reads", async () => {
    const model = createTodoListModel();
    model.control.replaceTodos([todo("1", "buy milk"), todo("2", "walk dog")]);
    const values: (string | undefined)[] = [];
    const titleOf = (id: string) =>
      createElement(Probe, { read: () => model.control.todos().find((t) => t.id === id)?.title, values });

    await mount(titleOf("1"), values);
    view!.root.render(titleOf("2"));
    await waitFor(() => values.length >= 2);
    expect(values).toEqual(["buy milk", "walk dog"]);
  });

  it("unsubscribes on unmount — no effect keeps reading for a component that is gone", async () => {
    // Counted at the source: the subscription is an effect that calls `read`.
    const model = createTodoListModel();
    let reads = 0;
    const read = () => {
      reads++;
      return model.view.lastOutcome();
    };
    const values: (string | undefined)[] = [];
    await mount(createElement(Probe, { read, values }), values);
    model.control.reportOutcome("x");
    await waitFor(() => values.length >= 2); // proves the subscription is live

    view!.unmount();
    view = undefined;
    await flush();
    const atUnmount = reads;
    model.control.reportOutcome("y");
    await flush();
    expect(reads, "a leaked subscription would have re-read").toBe(atUnmount);
  });

  it("a read that throws reaches React's error boundary — and never throws into the writer", async () => {
    // The no-effect-throws rule (spec §4.2): a throwing subscription effect
    // would throw out of `reportOutcome`, i.e. out of the CONTROLLER.
    const model = createTodoListModel();
    const read = () => {
      const outcome = model.view.lastOutcome();
      if (outcome === "boom") throw new Error("read failed");
      return outcome;
    };
    const caught: unknown[] = [];
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error: unknown) {
        caught.push(error);
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }
    const originalConsoleError = console.error;
    console.error = () => {}; // React logs the caught error; it is asserted below
    try {
      const values: (string | undefined)[] = [];
      await mount(createElement(Boundary, null, createElement(Probe, { read, values })), values);
      // A benign write first, proving the subscription is live (same shape as
      // "unsubscribes on unmount"): useSyncExternalStore registers `subscribe`
      // from a passive effect, which commits AFTER the layout effect `mount()`
      // waits on — without this, the throwing write below would run before any
      // effect subscribes, making it a no-op regardless of the try/catch.
      model.control.reportOutcome("ok");
      await waitFor(() => values.length >= 2);
      expect(() => model.control.reportOutcome("boom")).not.toThrow();
      await waitFor(() => caught.length > 0);
      expect(String(caught[0])).toMatch(/read failed/);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
