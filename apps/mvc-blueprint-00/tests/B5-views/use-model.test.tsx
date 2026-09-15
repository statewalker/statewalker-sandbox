import { afterEach, describe, expect, it } from "vitest";
import { createElement, useLayoutEffect } from "react";
import { TodoListModel, type Todo } from "@todo/app/models";
import { shallowEqual, useModel } from "@todo/ui";
import { flush, render, waitFor } from "../support/react.js";

/**
 * B5 — the whole React binding, over a real Chromium (spec §4.3).
 *
 * The sibling app's version (`fm-ui/src/use-model.ts`) is fifteen lines that
 * work only while every selector returns a primitive: `useCallback(() =>
 * selector(model), [model, selector])` recomputes on every render because
 * every call site passes an inline arrow, so a derived-array selector hands
 * `useSyncExternalStore` a fresh array each time it calls `getSnapshot` and
 * React refuses to render. `useModel` here must cache the last snapshot and
 * hand back the CACHED reference whenever the comparator says nothing
 * changed — that is the whole point of the `isEqual` parameter.
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

/**
 * Renders nothing; records every value `useModel` hands it, once per commit
 * (a layout effect, not the render body, so a discarded render-phase call
 * never inflates the count).
 */
function Probe<T>({
  model,
  selector,
  isEqual,
  values,
}: {
  model: TodoListModel;
  selector: (m: TodoListModel) => T;
  isEqual?: (a: T, b: T) => boolean;
  values: T[];
}) {
  const value = useModel(model, selector, isEqual);
  useLayoutEffect(() => {
    values.push(value);
  });
  return null;
}

describe("useModel", () => {
  it("re-renders when the selected primitive changes, driven by a mutator", async () => {
    const model = new TodoListModel();
    const values: (string | undefined)[] = [];

    await mount(createElement(Probe, { model, selector: (m) => m.lastOutcome, values }), values);
    expect(values).toEqual([undefined]);

    // A mutator, not a field write (spec §4.8) — `reportOutcome` is the
    // model's only way to change `lastOutcome`.
    model.reportOutcome("could not reach the store");
    await waitFor(() => values.length >= 2);

    expect(values).toEqual([undefined, "could not reach the store"]);
  });

  it("does not re-render when an unrelated field changes", async () => {
    const model = new TodoListModel();
    const values: (string | undefined)[] = [];

    await mount(createElement(Probe, { model, selector: (m) => m.lastOutcome, values }), values);
    expect(values).toEqual([undefined]);

    // Changes `todos`, not `lastOutcome` — but it's a mutator on the SAME
    // model object, so it fires the bare `onUpdate` our hook subscribes to.
    // Only the cache keeps this from re-rendering.
    model.replaceTodos([todo("1", "buy milk")]);
    // No predicate to poll FOR here — the point is that nothing happens.
    // Several real event-loop turns is the best a black-box test can do to
    // make "it wasn't merely late" credible.
    await flush();
    await flush();
    await flush();

    expect(values).toEqual([undefined]);
  });

  it("a derived-array selector with shallowEqual renders without error, and re-renders only when contents change", async () => {
    const model = new TodoListModel();
    const a = todo("1", "buy milk");
    const b = todo("2", "walk dog");
    model.replaceTodos([a, b]);

    const values: Todo[][] = [];
    await mount(
      createElement(Probe, { model, selector: (m) => m.visible(), isEqual: shallowEqual, values }),
      values,
    );
    expect(values).toHaveLength(1);
    expect(values[0]).toEqual([a, b]);

    // Same elements, same order — a NEW array both at `todos` and at
    // `visible()`, but shallow-equal content. No re-render.
    model.replaceTodos([a, b]);
    await flush();
    await flush();
    expect(values).toHaveLength(1);

    // Genuinely different contents — must re-render.
    const c = todo("3", "read book");
    model.replaceTodos([a, b, c]);
    await waitFor(() => values.length >= 2);
    expect(values).toHaveLength(2);
    expect(values[1]).toEqual([a, b, c]);
  });

  it("REGRESSION: samples the new model immediately after a model swap, even when the new value satisfies isEqual against the old cached value", async () => {
    // Two DIFFERENT model instances, both with an empty visible list. Under
    // shallowEqual, [] and [] are "equal" — which is exactly the trap: a
    // cache keyed only on the VALUE (not the model) would happily hand back
    // modelA's cached empty array after the component is re-pointed at
    // modelB, and nothing would ever notice, because an empty array looks
    // the same regardless of which model produced it.
    const modelA = new TodoListModel();
    const modelB = new TodoListModel();
    const selector = (m: TodoListModel) => m.visible();

    const values: Todo[][] = [];
    await mount(createElement(Probe, { model: modelA, selector, isEqual: shallowEqual, values }), values);
    expect(values).toHaveLength(1);
    const cachedFromA = values[0];

    // Re-render the SAME component instance — same hook state, same
    // `cache` ref — but pointed at modelB. This is the dock-shell case: a
    // panel is re-pointed at a different model without unmounting.
    view!.root.render(createElement(Probe, { model: modelB, selector, isEqual: shallowEqual, values }));
    await waitFor(() => values.length >= 2);

    // The value used for THIS render must be a fresh sample of modelB, not
    // modelA's stale cached reference — even though shallowEqual([], [])
    // is true, so a model-blind cache would (wrongly) call it a "hit".
    expect(values[1]).not.toBe(cachedFromA);
    expect(values[1]).toEqual(modelB.visible());

    // It also self-corrects on the next real change to B, which is the
    // part that made this bug easy to miss in the first place.
    modelB.replaceTodos([todo("1", "buy milk")]);
    await waitFor(() => values.length >= 3);
    expect(values[2]).toEqual([todo("1", "buy milk")]);
  });

  it("PROVES the comparator is load-bearing: the same derived selector with the default Object.is either throws React's getSnapshot-loop guard or warns about it", async () => {
    const model = new TodoListModel();
    model.replaceTodos([todo("1", "buy milk"), todo("2", "walk dog")]);

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
      // No isEqual: the default is Object.is, and `m.visible()` returns a
      // fresh array on every call — the exact shape spec §4.3 calls out.
      const values: Todo[][] = [];
      view = render(createElement(Probe, { model, selector: (m) => m.visible(), values }));
      // Give React's initial commit, its post-commit "did the store change
      // again" check, and any runaway loop it triggers, several turns to
      // surface — this render is expected to misbehave, so it cannot use the
      // ordinary `mount` helper, which waits for a well-behaved first commit.
      for (let i = 0; i < 20; i++) {
        await flush();
      }
    } catch (error) {
      thrown = error;
    } finally {
      console.error = originalConsoleError;
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onRejection);
    }

    const haystack = [
      thrown,
      ...windowErrors,
      ...consoleErrors.flat(),
    ]
      .map((v) => (v instanceof Error ? `${v.message}\n${v.stack ?? ""}` : String(v)))
      .join("\n");

    const sawLoopGuard =
      /getSnapshot should be cached/i.test(haystack) ||
      /Maximum update depth exceeded/i.test(haystack) ||
      /Too many re-renders/i.test(haystack);

    expect(
      sawLoopGuard,
      `expected React to surface its getSnapshot-loop guard; captured instead:\n${haystack || "(nothing)"}`,
    ).toBe(true);
  });

  it("a selector may close over props: re-rendered with a new prop, it re-selects", async () => {
    // The selector is not part of the cache key, and need not be: the CURRENT
    // selector runs on every `getSnapshot`, and the cache answers only when
    // the fresh value is equal to the cached one.
    const model = new TodoListModel();
    model.replaceTodos([todo("1", "buy milk"), todo("2", "walk dog")]);
    const values: (string | undefined)[] = [];
    const titleOf = (id: string) =>
      createElement(Probe, { model, selector: (m) => m.todos.find((t) => t.id === id)?.title, values });

    await mount(titleOf("1"), values);
    view!.root.render(titleOf("2"));
    await waitFor(() => values.length >= 2);
    expect(values).toEqual(["buy milk", "walk dog"]);
  });

  it("unsubscribes on unmount — the model keeps no listener for a component that is gone", async () => {
    // Every render test passes whether or not the subscription is released: a
    // leaked listener re-renders nothing that is still on screen. Counted at
    // the source instead — `useModel` subscribes through `model.onUpdate`.
    const model = new TodoListModel();
    const subscribe = model.onUpdate;
    let live = 0;
    model.onUpdate = (callback) => {
      live++;
      const off = subscribe(callback);
      return () => {
        live--;
        off();
      };
    };

    const values: (string | undefined)[] = [];
    await mount(createElement(Probe, { model, selector: (m) => m.lastOutcome, values }), values);
    // `useSyncExternalStore` subscribes in a passive effect, after the layout
    // effect `mount` waits for — so wait for the subscription itself.
    await waitFor(() => live > 0);

    view!.unmount();
    view = undefined;
    await flush();
    expect(live, "every subscription the component made was released").toBe(0);
  });
});
