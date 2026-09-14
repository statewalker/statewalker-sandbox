import { newAdapter } from "@statewalker/shared-adapters";
import type { Commands } from "@statewalker/shared-commands";
import type { Slots } from "@statewalker/shared-slots";

/**
 * The one context every controller receives — and no view ever does. A plain,
 * writable object: adapters cache their values on it.
 */
export type AppContext = Record<string, unknown>;

// No factory and no parent chain: an unset service throws, and nothing is inherited.
export const [getCommands, setCommands] = newAdapter<Commands, AppContext>("sys:commands", undefined, () => undefined);
export const [getSlots, setSlots] = newAdapter<Slots, AppContext>("sys:slots", undefined, () => undefined);
