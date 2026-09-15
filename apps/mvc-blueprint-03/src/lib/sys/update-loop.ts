export interface UpdateLoop {
  /** Schedules a pass in a microtask. Kicks in one tick share one pass; a kick during a pass earns one more. */
  kick(): void;
  /** Resolves once no pass is scheduled or running. */
  idle(): Promise<void>;
}

/**
 * A controller's single update loop. Listeners only kick it, so no model is
 * written inside its own listener (MODELS.md §4 point 5). A pass must be
 * idempotent: it reads every edge and does what is owed.
 */
export function newUpdateLoop(
  pass: () => Promise<void>,
  options: { isDisposed: () => boolean; onError: (error: unknown) => void },
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
        if (options.isDisposed()) break;
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
      if (options.isDisposed() || scheduled) return;
      scheduled = true;
      queueMicrotask(() => void run());
    },
    idle() {
      if (!scheduled && !running) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}
