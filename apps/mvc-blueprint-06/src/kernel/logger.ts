/** Diagnostics. A child logger per actor; entries go to a sink (tests collect them). */
export type Level = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly level: Level;
  readonly source: string;
  readonly message: string;
  readonly data?: unknown;
}

export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(name: string): Logger;
}

const consoleSink: LogSink = (e) => {
  if (e.level === "error") console.error(`[${e.source}] ${e.message}`, e.data ?? "");
  else if (e.level === "warn") console.warn(`[${e.source}] ${e.message}`, e.data ?? "");
};

export function newLogger(source: string, sink: LogSink = consoleSink): Logger {
  const at =
    (level: Level) =>
    (message: string, data?: unknown): void =>
      sink({ level, source, message, data });
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (name) => newLogger(name, sink),
  };
}
