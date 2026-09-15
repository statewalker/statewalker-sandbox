import { computed, effect, type Read, untracked } from "@sys/signals";

/** One level deep: arrays by element identity, plain objects by own-key identity. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => Object.is(value, b[i]));
  }
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const keys = Object.keys(ar);
  if (keys.length !== Object.keys(br).length) return false;
  return keys.every((k) => Object.hasOwn(br, k) && Object.is(ar[k], br[k]));
}

/**
 * A group derived from signals that keeps its reference while the new value is
 * shallow-equal to the last (MODELS.md §4 points 3 and 7). `derive` must read
 * every input before any data-dependent branch: a computed depends only on what
 * its last run read.
 */
export function stableGroup<T>(derive: () => T): Read<T> {
  let last: { value: T } | undefined;
  return computed(() => {
    const next = derive();
    if (last !== undefined && shallowEqual(last.value, next)) return last.value;
    last = { value: next };
    return next;
  });
}

export interface Channels {
  /** A MODELS.md change channel over one group read. */
  channel<T>(read: Read<T>): (listener: () => void) => () => void;
  /** Stops every subscription. Idempotent. */
  dispose(): void;
}

/**
 * Channels for one model. Each subscription is an effect that reads the group
 * (so it calls back immediately and on every change) and calls the listener
 * untracked, reporting a throwing listener with `console.error`. `isDisposed`
 * silences every channel synchronously: a model's `dispose()` sets its flag
 * first and releases its registry (which is async) afterwards.
 */
export function newChannels(isDisposed: () => boolean = () => false): Channels {
  let stopped = false;
  const stops = new Set<() => void>();
  const dead = () => stopped || isDisposed();
  return {
    channel<T>(read: Read<T>) {
      return (listener: () => void) => {
        if (dead()) return () => {};
        let active = true;
        const stop = effect(() => {
          read(); // the subscription IS this read — before any early return
          if (!active || dead()) return;
          untracked(() => {
            try {
              listener();
            } catch (error) {
              console.error(error);
            }
          });
        });
        stops.add(stop);
        return () => {
          if (!active) return;
          active = false;
          stops.delete(stop);
          stop();
        };
      };
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      for (const stop of [...stops]) stop();
      stops.clear();
    },
  };
}
