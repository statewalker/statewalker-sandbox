import type { Logger } from "@statewalker/shared-logger";

export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly error: unknown };

/** A readable reason. A listener's own error is unwrapped from the command bus's `listener-threw` wrapper. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const kind = (error as { kind?: unknown }).kind;
    if (kind === "listener-threw" && error.cause !== undefined) return describeError(error.cause);
    return error.message;
  }
  return String(error);
}

/** Runs one piece of work. Never rejects: a failure becomes a message naming the work, and an error log record. */
export async function attempt<T>(
  log: Logger,
  what: string,
  work: () => Promise<T>,
): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const message = `${what} failed: ${describeError(error)}`;
    log.error(message);
    return { ok: false, message, error };
  }
}
