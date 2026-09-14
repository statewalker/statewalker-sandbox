import { computed, effect, type Read, untracked } from "@signals";
import { shallowEqual } from "@sys";

/**
 * A group derived from signals that keeps its reference while the new value is
 * shallow-equal to the last (MODELS.md §4 points 3 and 7). A computed returning
 * the same reference propagates nothing, so equal recomputations wake nobody.
 * `derive` must read every input before any data-dependent branch: a computed
 * depends only on what its last run read.
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
  dispose(): void;
  readonly disposed: boolean;
}

/**
 * Channels for one model. Each subscription is an effect that reads the group
 * (so it calls back immediately and on every change), calls the listener
 * untracked, reports a throwing listener with `console.error` instead of letting
 * it reach the writer, and is stopped by its unsubscribe or by `dispose()`.
 */
export function newChannels(): Channels {
  let disposed = false;
  const stops = new Set<() => void>();
  return {
    get disposed() {
      return disposed;
    },
    channel<T>(read: Read<T>) {
      return (listener: () => void) => {
        if (disposed) return () => {};
        let active = true;
        const stop = effect(() => {
          read(); // the subscription IS this read — before any early return
          if (!active || disposed) return;
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
      if (disposed) return;
      disposed = true;
      for (const stop of [...stops]) stop();
      stops.clear();
    },
  };
}
