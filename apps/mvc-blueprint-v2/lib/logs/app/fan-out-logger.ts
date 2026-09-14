import type { Logger, LoggerLevel } from "@statewalker/shared-logger";
import { atLeast, type LoggerBackend, type LogRecord } from "@sys";

export interface FanOutLogger {
  /** Implements shared-logger's `Logger`; its identity never changes. */
  readonly logger: Logger;
  setBackends(backends: readonly LoggerBackend[]): void;
  /** Records suppressed because they were logged during delivery. */
  dropped(): number;
}

/**
 * Writes every call to the current backends as a frozen `LogRecord`, or to the
 * fallback logger while there are none. A call made WHILE records are being
 * delivered is dropped and counted: that single rule breaks every loop in
 * which a backend's write causes more logging (tracing a model notification
 * the write itself triggered), without an exclusion list to maintain.
 */
export function newFanOutLogger(options: {
  level?: LoggerLevel;
  fallback: Logger;
  now?: () => number;
}): FanOutLogger {
  let level: LoggerLevel = options.level ?? "trace";
  let backends: readonly LoggerBackend[] = [];
  let seq = 0;
  let dropped = 0;
  let delivering = false;
  const now = options.now ?? Date.now;

  const emit = (recordLevel: LoggerLevel, args: unknown[], metadata: Record<string, unknown>) => {
    if (!atLeast(recordLevel, level)) return;
    if (delivering) {
      dropped++;
      return;
    }
    if (backends.length === 0) {
      const target =
        Object.keys(metadata).length > 0 ? options.fallback.child(metadata) : options.fallback;
      target[recordLevel](...args);
      return;
    }
    const record: LogRecord = Object.freeze({
      seq: ++seq,
      at: now(),
      level: recordLevel,
      args: Object.freeze([...args]),
      metadata: Object.freeze({ ...metadata }),
      dropped,
    });
    delivering = true;
    try {
      for (const backend of backends) {
        try {
          backend.write(record);
        } catch (error) {
          console.error(error);
        }
      }
    } finally {
      delivering = false;
    }
  };

  const make = (metadata: Record<string, unknown>): Logger => ({
    get level() {
      return level;
    },
    set level(next: LoggerLevel) {
      level = next;
    },
    trace: (...args: unknown[]) => emit("trace", args, metadata),
    debug: (...args: unknown[]) => emit("debug", args, metadata),
    info: (...args: unknown[]) => emit("info", args, metadata),
    warn: (...args: unknown[]) => emit("warn", args, metadata),
    error: (...args: unknown[]) => emit("error", args, metadata),
    fatal: (...args: unknown[]) => emit("fatal", args, metadata),
    child: (extra: Record<string, unknown>) => make({ ...metadata, ...extra }),
  });

  return {
    logger: make({}),
    setBackends: (next) => {
      backends = [...next];
    },
    dropped: () => dropped,
  };
}
