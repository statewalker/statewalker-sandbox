import { useSyncExternalStore } from "react";

/**
 * The whole React binding for a MODELS.md model: a group getter and its change
 * channel. Both are stable facet members and the getter keeps its snapshot's
 * identity until the value changes, so no comparator or cache is needed.
 */
export function useModel<T>(read: () => T, subscribe: (listener: () => void) => () => void): T {
  return useSyncExternalStore(subscribe, read, read);
}
