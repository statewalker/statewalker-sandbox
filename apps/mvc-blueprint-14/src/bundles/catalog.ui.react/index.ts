import { reactCatalogSlot, type ReactCatalogEntry } from "@b/catalog/api/react";
import { type Controller, getSlots, newRegistry } from "@kernel";
import { implementations } from "./components.js";

/** `catalog.ui.react`: the React implementations of the eight generic catalog components. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  for (const [name, component] of Object.entries(implementations))
    register(slots.register(reactCatalogSlot, name, { component } as ReactCatalogEntry));
  return cleanup;
};
