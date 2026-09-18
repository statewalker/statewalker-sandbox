import { useSyncExternalStore } from "react";

/** The whole React binding (§12): a group getter and its change channel. */
export function useModel<T>(read: () => T, subscribe: (listener: () => void) => () => void): T {
  return useSyncExternalStore(subscribe, read, read);
}
