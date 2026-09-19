import { type Logger, newConsoleLogger } from "@statewalker/shared-logger";
import { newAdapter } from "./context.js";
import { KernelSlots } from "./slots.js";

export type { Logger, LoggerLevel } from "@statewalker/shared-logger";

/**
 * The kernel's services — the only adapters with factories. Each is created on first resolution,
 * which is what lets a bundle run standalone on `{}`.
 */
export const slotsAdapter = newAdapter<KernelSlots>("sys:slots", () => new KernelSlots());
export const loggerAdapter = newAdapter<Logger>("sys:logger", () => newConsoleLogger("warn"));
/** Plain host settings (e.g. `shell:notification-timeout-ms`). Read-only by convention. */
export const configAdapter = newAdapter<Readonly<Record<string, unknown>>>("sys:config", () =>
  Object.freeze({}),
);

export const getSlots = slotsAdapter.get;
export const getLogger = loggerAdapter.get;
export const getConfig = configAdapter.get;
