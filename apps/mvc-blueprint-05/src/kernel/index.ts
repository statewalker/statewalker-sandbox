/** The kernel: context + adapters, logger, store, loader, message and view helpers. */
import { newAdapter } from "./context.ts";
import { getLogger } from "./logger.ts";
import { createStore, type Store } from "./store.ts";

export * from "./context.ts";
export * from "./loader.ts";
export * from "./logger.ts";
export * from "./messages.ts";
export * from "./store.ts";
export * from "./views.ts";

/** The application's one store, created on first resolution. */
export const [getStore, setStore] = newAdapter<Store>("sys:store", (context) =>
  createStore(getLogger(context).child("store")),
);
