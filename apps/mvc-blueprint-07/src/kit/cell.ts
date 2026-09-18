/**
 * The model kit: an observable group ("cell") honouring MODELS.md §4, and `derived`. Optional —
 * `bundles/hello` hand-rolls the same contract without it. Substrate: a plain listener set.
 */
export interface Readable<T> {
  get(): T;
  /** calls back once immediately, then on every change (contract point 1) */
  subscribe(listener: () => void): () => void;
}
export interface Cell<T> extends Readable<T> {
  set(value: T): void;
  /** a coarse write; an explicitly-`undefined` field CLEARS it (contract point 9) */
  patch(patch: Partial<T>): void;
  dispose(): void;
}

export const shallowEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.hasOwn(b, k) &&
      Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
};

const reportOutOfBand = (error: unknown) => console.error("a model subscriber threw", error);

export function cell<T>(initial: T, onError: (e: unknown) => void = reportOutOfBand): Cell<T> {
  let value = initial;
  let disposed = false;
  let subs: Array<{ fn: () => void; active: boolean }> = [];
  const call = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      onError(error);
    }
  };
  const set = (next: T) => {
    if (disposed || shallowEqual(next, value)) return;
    value = next;
    for (const sub of subs) if (sub.active) call(sub.fn);
  };
  return {
    get: () => value,
    subscribe(fn) {
      const sub = { fn, active: !disposed };
      if (sub.active) subs = [...subs, sub];
      call(fn);
      return () => {
        if (!sub.active) return;
        sub.active = false;
        subs = subs.filter((s) => s !== sub);
      };
    },
    set,
    patch: (p) => set({ ...value, ...p }),
    dispose() {
      disposed = true;
      for (const sub of subs) sub.active = false;
      subs = [];
    },
  };
}

/** A read-only group recomputed whenever any source changes; one notification per changed value. */
export function derived<T>(
  sources: readonly Readable<unknown>[],
  compute: () => T,
): Readable<T> & { dispose(): void } {
  const out = cell(compute());
  const offs = sources.map((s) => s.subscribe(() => out.set(compute())));
  return {
    get: out.get,
    subscribe: out.subscribe,
    dispose() {
      for (const off of offs) off();
      out.dispose();
    },
  };
}

/** A view facet over a cell: the `getX` / `onXUpdate` pair of MODELS.md §2. */
export const group = <T>(c: Readable<T>) => ({ get: c.get, on: c.subscribe });
