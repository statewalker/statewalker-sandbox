/**
 * Browser stand-in for `node:async_hooks`, aliased in `vite.config.ts`.
 *
 * Why this exists
 * ---------------
 * `@flue/runtime@2` imports `AsyncLocalStorage` from `node:async_hooks` and
 * instantiates it at module top level (its instrumentation-owner registry).
 * Vite externalizes Node built-ins for browser builds as an empty object, so
 * without this shim the bundle dies on load with
 * "AsyncLocalStorage is not a constructor" — before any workbench code runs.
 *
 * Flue only uses that storage to attach `instrument(...)` registrations made
 * synchronously inside `runWithInstrumentationOwner(...)` (a Cloudflare-entry
 * path the workbench never takes), so a synchronous-scope implementation is
 * enough: the store is visible for the synchronous extent of `run()`, not
 * across `await`s. Browsers have no async-context propagation primitive
 * (AsyncContext is still a TC39 proposal); if Flue ever relies on context
 * surviving `await` in the browser path, this shim is where it breaks.
 *
 * The shim lives in `src/lib-host/` (not `src/lib/`) because it is a
 * build-time workaround for the host bundle; vitest runs on Node and uses the
 * real module.
 */
export class AsyncLocalStorage<T> {
  private current: T | undefined;

  getStore(): T | undefined {
    return this.current;
  }

  run<R, A extends unknown[]>(store: T, fn: (...args: A) => R, ...args: A): R {
    const previous = this.current;
    this.current = store;
    try {
      return fn(...args);
    } finally {
      this.current = previous;
    }
  }

  exit<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R {
    const previous = this.current;
    this.current = undefined;
    try {
      return fn(...args);
    } finally {
      this.current = previous;
    }
  }

  enterWith(store: T): void {
    this.current = store;
  }

  disable(): void {
    this.current = undefined;
  }
}

export default { AsyncLocalStorage };
