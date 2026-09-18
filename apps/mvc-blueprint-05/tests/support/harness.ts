/**
 * The headless test shell: the store *is* the recording host — `select(point)` is what a host
 * would render. Starts an application on a fresh context with a recording logger.
 */
import {
  type ApplicationManifest,
  application,
  type Context,
  createLogger,
  type FeatureManifest,
  getStore,
  type LogRecord,
  type Msg,
  type Store,
  setLogger,
} from "../../src/kernel/index.ts";

export interface Harness {
  context: Context;
  store: Store;
  logs: LogRecord[];
  errors(): LogRecord[];
  stop(): Promise<void>;
  dispatch(msg: Msg): void;
}

export async function start(
  features: readonly FeatureManifest[],
  inject: Record<string, unknown> = {},
): Promise<Harness> {
  const logs: LogRecord[] = [];
  const context: Context = { ...inject };
  setLogger(
    context,
    createLogger((r) => logs.push(r)),
  );
  const manifest: ApplicationManifest = { id: "test", features };
  const stop = (await application(manifest)(context)) ?? (async () => {});
  const store = getStore(context);
  return {
    context,
    store,
    logs,
    errors: () => logs.filter((r) => r.level === "error"),
    stop: async () => {
      await stop();
    },
    dispatch: (msg) => store.dispatch(msg),
  };
}

/** A manual gate: calls wait until `release()`; `pending` counts waiters. */
export function gate() {
  let waiters: Array<() => void> = [];
  let open = false;
  return {
    wait: () => (open ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
    release() {
      const w = waiters;
      waiters = [];
      for (const r of w) r();
    },
    openAll() {
      open = true;
      this.release();
    },
    get pending() {
      return waiters.length;
    },
  };
}

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
export async function until(predicate: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error("until: timed out");
    await tick();
  }
}
