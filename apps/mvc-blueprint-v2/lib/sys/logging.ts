import type { LoggerLevel } from "@statewalker/shared-logger";

/**
 * One log call, as a backend receives it. `args` follows the app's convention —
 * `[eventName, data]` — but a backend must tolerate anything. `dropped` is the
 * fan-out's running count of records suppressed during delivery (re-entrancy).
 */
export interface LogRecord {
  readonly seq: number;
  readonly at: number;
  readonly level: LoggerLevel;
  readonly args: readonly unknown[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly dropped: number;
}

/** Severity order, shared by every filter on levels (the fan-out logger, the inspector). */
export const LOG_LEVELS: readonly LoggerLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/** Whether `level` is at least as severe as `min`. */
export const atLeast = (level: LoggerLevel, min: LoggerLevel): boolean => LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(min);

/** What the logs controller needs from a contributed backend. Its owner may observe more. */
export interface LoggerBackend {
  write(record: LogRecord): void;
}
