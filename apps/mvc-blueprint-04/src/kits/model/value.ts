import { signal, untracked } from "@kit/signals";
import { newChannels } from "./channels.js";
import { shallowEqual } from "./equality.js";

/** One group: a getter, its channel, and a whole-group writer that compares before writing. */
export interface ValueModel<T> {
  get(): T;
  on(listener: () => void): () => void;
  set(value: T): void;
  dispose(): void;
}

/** The smallest presentation group: one value, shallow-compared on write, frozen by the caller. */
export function createValue<T>(initial: T): ValueModel<T> {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const value = signal(initial);
  return Object.freeze({
    get: () => value(),
    on: channels.channel(value),
    set: (next: T) => {
      if (disposed || shallowEqual(untracked(value), next)) return;
      value(next);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      channels.dispose();
    },
  });
}
