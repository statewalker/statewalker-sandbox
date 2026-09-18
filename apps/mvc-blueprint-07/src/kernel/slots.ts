import { Slots } from "@statewalker/shared-slots";
import { defineService } from "./context.js";

export {
  defineKeyedSlot,
  defineSlot,
  type KeyedSlotDeclaration,
  type SlotDeclaration,
  Slots,
} from "@statewalker/shared-slots";

/** Slots: things that EXIST — retained, pub/sub (ARCHITECTURE §5.2). */
export const [getSlots, setSlots] = defineService<Slots>("sys:slots", () => new Slots());
