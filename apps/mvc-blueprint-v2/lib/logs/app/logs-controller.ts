import {
  type Logger,
  type LoggerLevel,
  newConsoleLogger,
  removeLogger,
  setLogger,
} from "@statewalker/shared-logger";
import { newRegistry } from "@statewalker/shared-registry";
import { type AppContext, getSlots, loggerBackendsSlot } from "@sys";
import { newFanOutLogger } from "./fan-out-logger.js";

/**
 * Replaces the app's logger, as `shared-logger-pino`'s `initServiceLogger`
 * does, and keeps its fan-out in step with `sys:logger-backends`. It inherits
 * that package's constraint: activate it before anything else resolves the
 * logger, or the early caller keeps the default.
 */
export class LogsController {
  private readonly _registry = newRegistry();

  constructor(private readonly _options: { level?: LoggerLevel; fallback?: Logger } = {}) {}

  activate(ctx: AppContext): void {
    const [register] = this._registry;
    const slots = getSlots(ctx);
    const fanOut = newFanOutLogger({
      level: this._options.level ?? "trace",
      fallback: this._options.fallback ?? newConsoleLogger("info"),
    });
    setLogger(ctx, fanOut.logger);
    register(() => removeLogger(ctx));
    // observe() calls back immediately, so backends contributed earlier are picked up now.
    register(slots.observe(loggerBackendsSlot, (backends) => fanOut.setBackends(backends)));
  }

  async dispose(): Promise<void> {
    const [, cleanup] = this._registry;
    await cleanup();
  }
}
