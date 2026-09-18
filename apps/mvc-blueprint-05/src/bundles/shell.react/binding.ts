/** The React binding: one hook over the store. `useSyncExternalStore` needs stable snapshots — `select` is memoised per state. */
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";
import type { Point, Store } from "../../kernel/index.ts";

const StoreContext = createContext<Store | undefined>(undefined);

export const StoreProvider = ({ store, children }: { store: Store; children: ReactNode }) =>
  createElement(StoreContext.Provider, { value: store }, children);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore outside <StoreProvider>");
  return store;
}

export function usePoint<T>(point: Point<T>): readonly T[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.select(point));
}
