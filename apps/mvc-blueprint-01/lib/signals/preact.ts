import * as P from "@preact/signals-core";
import type { Read, Signal, SignalsImplementation } from "./contract.js";

export type { Read, Signal } from "./contract.js";

/**
 * The contract over @preact/signals-core — `.value` wrapped into call syntax.
 * The only file that imports `@preact/signals-core` (B0).
 */
export const implementation: SignalsImplementation = "preact";

export function signal<T>(initial: T): Signal<T> {
  const cell = P.signal(initial);
  // By argument COUNT, not by `value === undefined`: `s(undefined)` is a write.
  function access(): T;
  function access(value: T): void;
  function access(...args: [] | [T]): T | void {
    if (args.length === 0) return cell.value;
    cell.value = args[0];
  }
  return access;
}

export function computed<T>(fn: () => T): Read<T> {
  const cell = P.computed(fn);
  return () => cell.value;
}

export function effect(fn: () => void): () => void {
  return P.effect(() => {
    fn();
  });
}

export function batch<T>(fn: () => T): T {
  return P.batch(fn);
}

export function untracked<T>(fn: () => T): T {
  return P.untracked(fn);
}
