/**
 * The one reactive surface this app uses — alien-signals' own shape (call
 * syntax: `s()` reads, `s(v)` writes), minus what the app does not need. Types
 * only: no library is named here. `alien.ts` and `preact.ts` implement it;
 * `deps.ts` chooses one; the contract suite (B1) proves both meet it.
 */

/** A writable reactive cell. */
export interface Signal<T> {
  /** Reads — and, inside an effect or a computed, subscribes. */
  (): T;
  /** Writes. A write `===` to the current value notifies nobody. */
  (value: T): void;
}

/** A read-only view: a computed, or a signal's reader handed out without its setter. */
export type Read<T> = () => T;

export interface Signals {
  signal<T>(initial: T): Signal<T>;
  computed<T>(fn: () => T): Read<T>;
  /** Runs `fn` now, and again whenever what it read last time changes. Returns stop. Owned by nobody. */
  effect(fn: () => void): () => void;
  /** Defers every effect woken inside `fn` to the end of the outermost batch. */
  batch<T>(fn: () => T): T;
  /** Runs `fn` with no subscriber: its reads create no dependency. */
  untracked<T>(fn: () => T): T;
}

export type SignalsImplementation = "alien" | "preact";
