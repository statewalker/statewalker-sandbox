import type { Logger } from "@kernel";

export interface UpdateLoop {
  /** Schedules a pass in a microtask. Kicks in one tick share one pass; a kick during a pass earns one more. */
  kick(): void;
  /** Resolves once no pass is scheduled or running. */
  idle(): Promise<void>;
}

/**
 * A controller's single update loop (from mvc-blueprint-03). Listeners only kick it, so no model
 * is written inside its own listener. A pass must be idempotent: it reads every edge.
 */
export function newUpdateLoop(
  pass: () => Promise<void>,
  options: { isActive: () => boolean; onError: (error: unknown) => void },
): UpdateLoop {
  let scheduled = false;
  let running = false;
  let rerun = false;
  let waiters: (() => void)[] = [];
  const settle = () => {
    if (scheduled || running) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  };
  const run = async () => {
    scheduled = false;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        if (!options.isActive()) break;
        try {
          await pass();
        } catch (error) {
          options.onError(error);
        }
      } while (rerun);
    } finally {
      running = false;
      settle();
    }
  };
  return {
    kick() {
      if (!options.isActive() || scheduled) return;
      scheduled = true;
      queueMicrotask(() => void run());
    },
    idle() {
      if (!scheduled && !running) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}

/** A readable reason; unwraps the command bus's `listener-threw` wrapper. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const kind = (error as { kind?: unknown }).kind;
    if (kind === "listener-threw" && error.cause !== undefined) return describeError(error.cause);
    return error.message;
  }
  return String(error);
}

export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly error: unknown };

/** Runs one piece of work; never rejects. A failure is logged at warn (it is owner state, not a crash). */
export async function attempt<T>(
  log: Logger,
  what: string,
  work: () => Promise<T>,
): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const message = describeError(error);
    log.warn(`${what} failed`, { error: message });
    return { ok: false, message, error };
  }
}
