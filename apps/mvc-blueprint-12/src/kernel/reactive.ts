import * as A from "alien-signals";
import type { Listener, Unsubscribe } from "./models.js";

/**
 * P4 — THE SHARED REACTIVE SUBSTRATE. The kernel owns one reactive graph (alien-signals) and every
 * bundle that shares state publishes it on this graph, so a consumer's `computed` can read another
 * bundle's value directly and is glitch-free across bundles. This is the only file that imports
 * `alien-signals` (boundary rule R7); everything else reaches the library through the kernel.
 *
 * What this breaks (ADR-008): the substrate is no longer private — `Readable<T>` appears in API
 * modules, and its tracked-read semantics are those of THIS graph.
 */

declare const READABLE: unique symbol;

/**
 * A shared value on the kernel substrate.
 *
 * - `r()` — the value. Inside a kernel `computed`/`effect` (or a kit action's `when`), a TRACKED
 *   read: the derivation re-runs when it changes, glitch-free, whatever bundle owns it.
 * - `r.subscribe(listener)` — the model contract's channel (MODELS.md §4): calls back at once and
 *   after every change; a throwing listener is reported and never reaches the writer. This is how a
 *   consumer that does not use the substrate (plain listeners) follows the value.
 *
 * Branded: only `readable()` / `fromChannel()` make one, so a hand-rolled getter that the graph
 * cannot track does not type-check where a `Readable` is required.
 */
export interface Readable<T> {
  (): T;
  subscribe(listener: Listener): Unsubscribe;
  readonly [READABLE]: true;
}

/** The read overload is last, so a `Signal<T>` passed as `() => T` infers `T`. */
export interface Signal<T> {
  (value: T): void;
  (): T;
}

export function signal<T>(initial: T): Signal<T> {
  return A.signal(initial) as Signal<T>;
}

export function computed<T>(fn: () => T): () => T {
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

/**
 * Publishes a read on the graph as a `Readable`. `alive` (the owner's) silences every
 * subscription after the owner's dispose (contract point 8); reads keep returning the last value.
 */
export function readable<T>(read: () => T, alive: () => boolean = () => true): Readable<T> {
  const r = (() => read()) as Readable<T>;
  (r as { subscribe: Readable<T>["subscribe"] }).subscribe = (listener) => {
    if (!alive()) return () => {};
    let active = true;
    const stop = effect(() => {
      read();
      if (!active || !alive()) return;
      untracked(() => {
        try {
          listener();
        } catch (error) {
          console.error(error);
        }
      });
    });
    return () => {
      if (!active) return;
      active = false;
      stop();
    };
  };
  return Object.freeze(r);
}

/**
 * The bridge for a producer that is NOT on the substrate (a listener set, a remote proxy): a
 * signal fed by its channel. Tracked reads work, but glitch-freedom stops at the bridge — the
 * signal is written from the producer's notification, after whoever subscribed to it earlier.
 */
export function fromChannel<T>(
  get: () => T,
  on: (listener: Listener) => Unsubscribe,
): { readonly read: Readable<T>; stop(): void } {
  const value = signal(get());
  let live = true;
  const off = on(() => {
    if (live) value(get());
  });
  return {
    read: readable(value, () => live),
    stop() {
      live = false;
      off();
    },
  };
}
