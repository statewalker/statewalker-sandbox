import { computed, effect, type Read, untracked } from "@kit/signals";
import { shallowEqual } from "./equality.js";

/**
 * A derived group that keeps its reference while the new value is shallow-equal to the last
 * (MODELS.md §4 points 3 and 7). `derive` must read every input before any data-dependent branch.
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
 * Change channels for one model: each subscription is an effect that reads the group (so it calls
 * back at once and on each change) and calls the listener untracked; a throwing listener is
 * reported with `console.error` and never reaches the writer.
 */
export function newChannels(isDisposed: () => boolean): Channels {
  let stopped = false;
  const stops = new Set<() => void>();
  const dead = () => stopped || isDisposed();
  return {
    channel<T>(read: Read<T>) {
      return (listener: () => void) => {
        if (dead()) return () => {};
        let active = true;
        const stop = effect(() => {
          read();
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
