import { catalogSlot } from "@b/catalog/api";
import { type Controller, getSlots } from "@kernel";
import { dyn } from "@kit/catalog";
import { z } from "zod";

/**
 * `badge` (feature `ui.badge`): one more catalog component from an independent bundle — the cost
 * of adding vocabulary. Nothing else changes: the agent's catalog, prompt and validation pick it up.
 */
export const activate: Controller = async (context) =>
  getSlots(context).register(catalogSlot, "Badge", {
    props: z.object({ text: dyn(z.string()), tone: z.enum(["info", "warn"]).optional() }),
    slots: [],
    events: [],
    description: "A short status label.",
  });
