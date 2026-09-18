import { newAdapter } from "./context.ts";

export type Level = "debug" | "info" | "warn" | "error";
export interface LogRecord {
  readonly level: Level;
  readonly name: string;
  readonly message: string;
  readonly args: readonly unknown[];
}
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(name: string): Logger;
}

/** A logger writing to `sink` (the console by default). Tests pass a sink that records. */
export function createLogger(
  sink: (record: LogRecord) => void = consoleSink,
  name = "app",
): Logger {
  const at =
    (level: Level) =>
    (message: string, ...args: unknown[]) =>
      sink({ level, name, message, args });
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (child) => createLogger(sink, `${name}/${child}`),
  };
}

function consoleSink(r: LogRecord): void {
  if (r.level === "debug") return;
  console[r.level](`[${r.name}] ${r.message}`, ...r.args);
}

export const [getLogger, setLogger] = newAdapter<Logger>("sys:logger", () => createLogger());
