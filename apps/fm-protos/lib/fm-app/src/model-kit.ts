import { type BaseClass, onChange } from "@statewalker/shared-baseclass";

/**
 * C1 — the model kit.
 *
 * P0/M4 survived its first mutation pass: replacing `entries = buffer` with an
 * in-place `push` broke nothing, because `push()` + `notify()` is invisible to
 * an `onChange` watcher. Every level field holding an array or object carries
 * that hazard. Rather than remembering to test it per model, these three
 * helpers constrain models as they are written.
 */

export interface Probe {
  /** Number of times the watcher observed an actual change. */
  readonly count: number;
  stop(): void;
}

/** Watches one selector for strict-equality change. */
export function probe<T>(model: BaseClass, selector: () => T): Probe {
  let count = 0;
  const off = onChange(
    (cb: () => void) => model.onUpdate(cb),
    () => count++,
    selector,
  );
  return {
    get count() {
      return count;
    },
    stop: off,
  };
}

/**
 * Asserts that a level field is REPLACED rather than mutated: the watcher must
 * observe the change. Pass the write you expect the controller to perform.
 */
export async function expectReplacedNotMutated<T>(
  model: BaseClass,
  selector: () => T,
  write: () => void | Promise<void>,
): Promise<void> {
  const watcher = probe(model, selector);
  await write();
  watcher.stop();
  if (watcher.count === 0) {
    throw new Error(
      "level field was mutated in place: `push()`/`splice()` + notify() is invisible " +
        "to an onChange watcher. Replace the value instead.",
    );
  }
}

/**
 * Asserts a controller cannot wake itself: writes to the OUTER model must not
 * trigger the reaction that is subscribed to `input`.
 */
export async function expectNoSelfWake(
  input: BaseClass,
  outer: BaseClass,
  reactions: () => number,
  write: () => void | Promise<void>,
): Promise<void> {
  void input;
  const before = reactions();
  await write();
  outer.notify();
  if (reactions() !== before) {
    throw new Error(
      "controller reacted to its own write: the reaction must be subscribed to " +
        "`input`, not to the outer model it writes.",
    );
  }
}

/**
 * Asserts a field is edge-shaped: two increments in one tick are both
 * observed. A boolean `submitted` cannot express two clicks in one tick.
 */
export function expectEdgeCounter(
  input: BaseClass & Record<string, unknown>,
  field: string,
  observe: () => number,
): void {
  const start = observe();
  const value = input[field];
  if (typeof value !== "number") {
    throw new Error(`${field} must be a monotonic counter, not ${typeof value}`);
  }
  (input as Record<string, unknown>)[field] = (value as number) + 1;
  (input as Record<string, unknown>)[field] = (value as number) + 2;
  input.notify();
  if (observe() - start < 2) {
    throw new Error(
      `${field} lost an edge: two increments in one tick must both be observed ` +
        "(compare against a handled watermark, not a boolean).",
    );
  }
}
