import type { BaseClass } from "@statewalker/shared-baseclass";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The whole React binding: fifteen lines over `useSyncExternalStore`.
 *
 * This is the selector semantics that would otherwise justify a store library
 * (file 07). A component subscribes to one derived value and re-renders when
 * that value changes by strict equality — which is exactly why level fields
 * holding arrays must be REPLACED, never mutated (C1).
 */
export function useModel<M extends BaseClass, T>(model: M, selector: (model: M) => T): T {
  const subscribe = useCallback((onChange: () => void) => model.onUpdate(onChange), [model]);
  const snapshot = useCallback(() => selector(model), [model, selector]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
