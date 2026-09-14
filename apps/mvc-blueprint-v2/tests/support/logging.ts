import type { Logger, LoggerLevel } from "@statewalker/shared-logger";

export interface LoggedCall {
  level: LoggerLevel;
  args: unknown[];
  metadata: Record<string, unknown>;
}

/** A `Logger` that records every call, children included, with their merged metadata. */
export function newRecordingLogger(): { logger: Logger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  let level: LoggerLevel = "trace";
  const make = (metadata: Record<string, unknown>): Logger => {
    const write = (l: LoggerLevel) => (...args: unknown[]) => {
      calls.push({ level: l, args, metadata });
    };
    return {
      get level() {
        return level;
      },
      set level(next: LoggerLevel) {
        level = next;
      },
      trace: write("trace"),
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
      fatal: write("fatal"),
      child: (extra) => make({ ...metadata, ...extra }),
    };
  };
  return { logger: make({}), calls };
}
