import * as A from "alien-signals";
import type { Read, Signal, SignalsImplementation } from "./contract.js";

export type { Read, Signal } from "./contract.js";

/**
 * The contract over alien-signals — nearly a re-export, because the contract IS
 * alien's shape. The only file that imports `alien-signals` (B0).
 */
export const implementation: SignalsImplementation = "alien";

export function signal<T>(initial: T): Signal<T> {
  return A.signal(initial);
}

export function computed<T>(fn: () => T): Read<T> {
  // alien hands its getter the previous value; the contract's `fn` takes none.
  return A.computed(() => fn());
}

export function untracked<T>(fn: () => T): T {
  const previous = A.setActiveSub(undefined);
  try {
    return fn();
  } finally {
    A.setActiveSub(previous);
  }
}

export function batch<T>(fn: () => T): T {
  A.startBatch();
  try {
    return fn();
  } finally {
    A.endBatch();
  }
}

export function effect(fn: () => void): () => void {
  // Created with no active subscriber, so nobody owns it. alien otherwise
  // disposes an effect created during another effect's run when that effect
  // re-runs; preact never does. Contract guarantee 8 makes both behave like
  // preact — a controller activated from inside some reaction must not die
  // with it.
  return untracked(() =>
    A.effect(() => {
      fn();
    }),
  );
}
