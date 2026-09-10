import { useCallback, useRef, useSyncExternalStore } from "react";
import type { BaseClass } from "@statewalker/shared-baseclass";

/**
 * The whole React binding — spec §4.3.
 *
 * A sibling app's version of this hook is fifteen lines over
 * `useSyncExternalStore`: `useCallback(() => selector(model), [model,
 * selector])` as the snapshot. It survives only while every selector returns
 * a primitive, because every call site passes an inline arrow — `selector`
 * therefore has a fresh identity on every render, and `useCallback` cannot
 * memoize a snapshot FUNCTION into a memoized snapshot VALUE. The first
 * selector returning a derived array (`m => m.visible()`) hands
 * `useSyncExternalStore` a new array reference on every call to
 * `getSnapshot`, and React refuses to render: "The result of getSnapshot
 * should be cached to avoid an infinite loop."
 *
 * The fix is not a memoized selector — the call sites are what have the
 * fresh identity, and that is not going to change. The fix is caching the
 * SNAPSHOT: keep the last value this hook returned, and whenever `isEqual`
 * says the newly computed value is equivalent to it, hand back the SAME
 * reference rather than the new one. `useSyncExternalStore` (and React's own
 * post-commit "did the store change again" check) compare by `Object.is`,
 * so a cached reference is indistinguishable from "nothing changed" — which
 * is exactly what an unchanged derived value is.
 *
 * `isEqual` defaults to `Object.is`, which is correct for a selector that
 * already returns a primitive or a stable reference, and is why the default
 * alone is not enough for `m => m.visible()` — see `shallowEqual` below.
 */
export function useModel<M extends BaseClass, T>(
  model: M,
  selector: (model: M) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  // A ref, not state: writing it is a caching side effect of computing the
  // snapshot, not a change this component should ever render for. Wrapped in
  // an object so "no snapshot cached yet" is distinguishable from "the cached
  // value is `undefined`", and keyed by MODEL, not just value: a component
  // instance can be re-pointed at a different model (the dock shell's
  // central case — a panel re-pointed at a new model as it comes and goes)
  // without unmounting, and two different models can legitimately produce
  // `isEqual` values (two empty lists, under `shallowEqual`, is the obvious
  // case). Comparing only `cached.value` against `next` would then return
  // the OLD model's cached reference and never sample the new model at all
  // — a stale read that self-corrects only once the new model changes for
  // real, which is exactly what made it easy to miss.
  //
  // `selector` is deliberately NOT part of the cache key. Every call site
  // passes an inline arrow (that is the whole reason this hook exists — see
  // the module doc), so keying on selector identity would make every render
  // a cache miss and reintroduce the fresh-array-every-call loop this hook
  // exists to prevent. The contract this relies on: `selector` must be
  // semantically stable for a given model (the same projection of the same
  // model), which holds for every selector in this codebase (`m =>
  // m.lastOutcome`, `m => m.visible()`, …) — none of them close over
  // anything besides their parameter.
  const cache = useRef<{ model: M; value: T } | undefined>(undefined);

  // Only `model` in the dependency list: `onUpdate` is a bound arrow field
  // (base-class.ts), stable for the model's lifetime, so this need not — and
  // per spec §4.10 must not — be recreated for every inline selector.
  const subscribe = useCallback((onStoreChange: () => void) => model.onUpdate(onStoreChange), [model]);

  const getSnapshot = useCallback((): T => {
    const next = selector(model);
    const cached = cache.current;
    if (cached !== undefined && cached.model === model && isEqual(cached.value, next)) {
      return cached.value;
    }
    cache.current = { model, value: next };
    return next;
  }, [model, selector, isEqual]);

  // No separate server snapshot: this app never renders on the server.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Structural equality for the two shapes a selector actually returns here: a
 * plain array (`m => m.visible()`) or a plain object. `Object.is` on each
 * element/value, one level deep — deliberately shallow, matching the level
 * fields it is meant to compare (spec §4.2 requires they be REPLACED, not
 * mutated, so one level of comparison is exactly what is needed and no
 * more).
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key) || !Object.is(aRecord[key], bRecord[key])) {
      return false;
    }
  }
  return true;
}
