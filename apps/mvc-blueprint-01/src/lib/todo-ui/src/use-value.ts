import { effect, untracked } from "@todo/signals";
import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * The whole React binding — spec §4.5 — on the signals contract alone.
 *
 * SUBSCRIBE is an effect that calls `read()`: whatever `read` reads is what the
 * component depends on, nothing more. On every run but the first it tells
 * React, inside `untracked` — React calls `getSnapshot` synchronously from
 * `onStoreChange`, and without `untracked` the snapshot's reads would be
 * tracked by this effect. A `read()` that throws is caught here: an effect that
 * throws would throw out of whoever wrote the signal — the controller — and on
 * alien would skip every other effect in that flush (spec §4.2). React still
 * hears of the change, and `getSnapshot` rethrows, into its error boundary.
 *
 * GETSNAPSHOT is `untracked(read)`, cached: for the SAME `read`, while
 * `isEqual(previous, next)` holds, it returns the previous reference. React
 * calls `getSnapshot` more than once per render and compares by `Object.is`,
 * so an inline derivation returning a fresh array would otherwise loop it
 * ("The result of getSnapshot should be cached"). Keyed by `read` as well as
 * by value: a component re-pointed at another model gets that model's value,
 * never the old model's equal-looking one. An inline `read` is a new function
 * each render, so it misses once per render — never twice within one, which is
 * what the loop needs.
 *
 * Pass facet reads (`model.visible`): they are stable, so the component
 * subscribes once. An inline `() => …` resubscribes on every render — correct,
 * and more work.
 */
export function useValue<T>(read: () => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ read: () => T; value: T } | undefined>(undefined);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let first = true;
      return effect(() => {
        try {
          read();
        } catch {
          // getSnapshot rethrows it during render, into React's error boundary.
        }
        if (first) {
          first = false;
          return;
        }
        try {
          untracked(onStoreChange);
        } catch (error) {
          // React can throw out of onStoreChange ("Maximum update depth
          // exceeded"), which would otherwise reach the writer — the
          // controller — and, on alien, skip the rest of that flush (no
          // effect in this app throws). Rethrow on a microtask instead, so it
          // still surfaces without escaping this effect.
          queueMicrotask(() => {
            throw error;
          });
        }
      });
    },
    [read],
  );

  const getSnapshot = useCallback((): T => {
    const next = untracked(read);
    const cached = cache.current;
    if (cached !== undefined && cached.read === read && isEqual(cached.value, next))
      return cached.value;
    cache.current = { read, value: next };
    return next;
  }, [read, isEqual]);

  // No separate server snapshot: this app never renders on the server.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Structural equality for the two shapes a read returns here: a plain array or
 * a plain object. `Object.is` on each element/value, one level deep — arrays are
 * REPLACED, never mutated, so one level is exactly what is needed.
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  if (aKeys.length !== Object.keys(bRecord).length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(bRecord, key) || !Object.is(aRecord[key], bRecord[key])) return false;
  }
  return true;
}
