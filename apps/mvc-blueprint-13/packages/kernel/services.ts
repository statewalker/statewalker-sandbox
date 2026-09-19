import { type Logger, newConsoleLogger } from "@statewalker/shared-logger";
import { type Context, newAdapter } from "./context.js";
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

/** This copy's identity. A second kernel copy on one context is refused, loudly (W8). */
const KERNEL = Symbol("@p5/kernel");
/** Resolves the bus — and claims the context for this kernel copy: the kernel is a singleton. */
export const getSlots = (context: Context): KernelSlots => {
  const owner = (context["sys:kernel"] ??= KERNEL);
  if (owner !== KERNEL) throw new Error("two copies of @p5/kernel: make it a singleton peer");
  return slotsAdapter.get(context);
};
export const getLogger = loggerAdapter.get;
export const getConfig = configAdapter.get;
