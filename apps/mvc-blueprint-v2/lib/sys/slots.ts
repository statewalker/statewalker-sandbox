import { defineSlot } from "@statewalker/shared-slots";
import type { LoggerBackend } from "./logging.js";
import type { RunningOperation } from "./operations.js";

/** Controllers contribute backends; the logs controller fans every record out to them. */
export const loggerBackendsSlot = defineSlot<LoggerBackend>("sys:logger-backends");

/** Controllers contribute operations in flight; the progress controller projects them into `ui:progress`. */
export const runningOperationsSlot = defineSlot<RunningOperation>("ops:running");
