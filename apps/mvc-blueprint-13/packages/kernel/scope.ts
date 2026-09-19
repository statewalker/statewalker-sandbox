/**
 * K §4.1 (4): the kernel's one disposal mechanism. A scope is a disposal registry plus an abort
 * signal plus `task`, whose continuation runs only while the scope is open. The loader gives each
 * activation a bundle scope; a controller opens child scopes (sessions). Closing a scope closes its
 * children first (newest first), then runs its own disposers in reverse.
 *
 * There is no "check you are still active after `await`" rule: await through `scope.task(…)`, and a
 * continuation whose scope has closed never runs (R2's droppable turns and P2's state-scoped tasks,
 * without a mailbox or a chart).
 */

export type Cleanup = () => void | Promise<void>;

export interface Scope {
  /** Aborted when the scope closes: hand it to `fetch` and friends. */
  readonly signal: AbortSignal;
  readonly closed: boolean;
  /** The parent scope, if any (a session's parent is its bundle scope). */
  readonly parent?: Scope;
  /** Whether the loader opened it for one bundle activation. */
  readonly isBundle: boolean;
  /**
   * Registers a disposer (run on close, in reverse). Returns `release`: runs it now, once, and
   * forgets it — for something withdrawn before its scope closes. After close, runs it at once.
   */
  defer(dispose: Cleanup): () => void;
  /** Opens a child scope, closed before this scope's own disposers. */
  child(): Scope;
  /**
   * Settles as `work` does, but only while this scope is open: once it has closed, the returned
   * promise never settles, so the `await`ing continuation is dropped.
   */
  task<T>(work: Promise<T> | ((signal: AbortSignal) => Promise<T>)): Promise<T>;
  /** Closes children, runs disposers; idempotent. Rejects with the first disposer failure. */
  close(): Promise<void>;
}

export function newScope(parent?: Scope, isBundle = false): Scope {
  const abort = new AbortController();
  const disposers: Cleanup[] = [];
  const children = new Set<Scope>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const scope: Scope = {
    signal: abort.signal,
    get closed() {
      return closed;
    },
    parent,
    isBundle,
    defer(dispose) {
      if (closed) {
        void dispose();
        return () => {};
      }
      disposers.push(dispose);
      return () => {
        const i = disposers.lastIndexOf(dispose);
        if (i < 0) return;
        disposers.splice(i, 1);
        void dispose();
      };
    },
    child() {
      const c = newScope(scope);
      if (closed) {
        void c.close();
        return c;
      }
      children.add(c);
      c.defer(() => void children.delete(c));
      return c;
    },
    task<T>(work: Promise<T> | ((signal: AbortSignal) => Promise<T>)) {
      const p = typeof work === "function" ? work(abort.signal) : work;
      return new Promise<T>((resolve, reject) => {
        p.then(
          (value) => {
            if (!closed) resolve(value);
          },
          (error) => {
            if (!closed) reject(error);
          },
        );
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      abort.abort();
      const errors: unknown[] = [];
      const pending: Promise<void>[] = [];
      const run = (fn: () => void | Promise<void>) => {
        try {
          const out = fn();
          if (out) pending.push(out.catch((e) => void errors.push(e)));
        } catch (error) {
          errors.push(error);
        }
      };
      for (const c of [...children].reverse()) run(() => c.close());
      for (const d of disposers.splice(0).reverse()) run(d);
      closing = Promise.all(pending).then(() => {
        if (errors.length > 0) throw errors[0];
      });
      return closing;
    },
  };
  return scope;
}
