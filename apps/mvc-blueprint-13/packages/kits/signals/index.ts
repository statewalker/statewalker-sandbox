import * as A from "alien-signals";

/**
 * The model kit's reactive substrate — alien-signals behind a four-function surface. The only
 * file that imports `alien-signals` (boundary suite). Private to model implementations.
 */
export type Read<T> = () => T;
export interface Signal<T> {
  (): T;
  (value: T): void;
}

export function signal<T>(initial: T): Signal<T> {
  return A.signal(initial) as Signal<T>;
}

export function computed<T>(fn: () => T): Read<T> {
  return A.computed(() => fn());
}

export function untracked<T>(fn: () => T): T {
  const previous = A.setActiveSub(undefined);
  try {
    return fn();
  } finally {
    A.setActiveSub(previous);
  }
}

export function batch<T>(fn: () => T): T {
  A.startBatch();
  try {
    return fn();
  } finally {
    A.endBatch();
  }
}

/** An effect owned by nobody (created untracked, so a surrounding effect's re-run cannot dispose it). */
export function effect(fn: () => void): () => void {
  return untracked(() =>
    A.effect(() => {
      fn();
    }),
  );
}

/** Reads made on this substrate (kit-made getters). A WeakSet: it holds no state of its own. */
const onGraph = new WeakSet<object>();

/**
 * Marks a model getter as a read on the kit's graph, so a kit `track` elsewhere reads it directly
 * (tracked, glitch-free) instead of bridging it through its change channel (K §4.3, D11).
 */
export function readable<T>(read: Read<T>): Read<T> {
  const r = () => read();
  Object.defineProperty(r, "name", { value: read.name }); // not "r": the dev guard names getters
  onGraph.add(r);
  return r;
}

export function isReadable(fn: unknown): boolean {
  return typeof fn === "function" && onGraph.has(fn);
}
