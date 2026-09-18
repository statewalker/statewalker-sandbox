import { defineService } from "./context.js";

export type Level = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  readonly level: Level;
  readonly source: string;
  readonly message: string;
  readonly detail?: unknown;
}
export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  child(source: string): Logger;
  /** Everything logged through this logger family, oldest first (diagnostics and tests). */
  entries(): readonly LogEntry[];
}

/** A logger family that records every entry and forwards warn/error to the console (unless quiet). */
export function createLogger(options: { quiet?: boolean; source?: string } = {}): Logger {
  const all: LogEntry[] = [];
  const make = (source: string): Logger => {
    const write = (level: Level) => (message: string, detail?: unknown) => {
      all.push({ level, source, message, detail });
      if (options.quiet) return;
      if (level === "error") console.error(`[${source}] ${message}`, detail ?? "");
      else if (level === "warn") console.warn(`[${source}] ${message}`, detail ?? "");
    };
    return {
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
      child: (name) => make(`${source}/${name}`),
      entries: () => all,
    };
  };
  return make(options.source ?? "app");
}

export const [getLogger, setLogger] = defineService<Logger>("sys:logger", () => createLogger());
