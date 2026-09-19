import { reactCatalogSlot } from "@b/catalog/api/react";
import { type Controller, getSlots } from "@kernel";
import { Badge } from "./badge.js";

/** `badge.ui.react`: the React implementation of `Badge`. */
export const activate: Controller = async (context) =>
  getSlots(context).register(reactCatalogSlot, "Badge", { component: Badge as never });
