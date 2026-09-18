import type { Readable } from "svelte/store";

/**
 * THE Svelte binding: one model group as a Svelte store. Svelte's store contract (call `run` at
 * once, then on every change; return the unsubscribe) is the model contract's points 1 and 4, so
 * the adapter only turns "no-argument listener + getter" into "listener receives the value".
 * Svelte treats every object a store emits as changed (`safe_not_equal`), so the adapter drops a
 * notification whose snapshot kept its identity (contract point 7) — otherwise a no-op
 * notification re-runs the template.
 * Usage in a component: `const items = $derived(modelStore(model.getItems, model.onItemsUpdate))`,
 * then `$items`.
 */
export function modelStore<T>(
  read: () => T,
  subscribe: (listener: () => void) => () => void,
): Readable<T> {
  return {
    subscribe(run) {
      let first = true;
      let last: T;
      return subscribe(() => {
        const next = read();
        if (!first && Object.is(next, last)) return;
        first = false;
        last = next;
        run(next);
      });
    },
  };
}
