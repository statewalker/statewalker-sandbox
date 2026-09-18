import type { SlotDeclaration, Slots } from "../kernel/slots.js";
import { cell, type Readable } from "./cell.js";

/**
 * Follows a single-contribution slot that publishes a model (e.g. `todos:collection`): the value of
 * one of its groups, or `initial` while nothing is published. Retained slots make arrival order moot.
 */
export function followSlot<V, T>(
  slots: Slots,
  slot: SlotDeclaration<V>,
  pick: (view: V) => Readable<T>,
  initial: T,
): Readable<T> & { readonly present: Readable<boolean>; dispose(): void } {
  const out = cell<T>(initial);
  const present = cell(false);
  let off: (() => void) | undefined;
  const offSlot = slots.observe(slot, (values) => {
    off?.();
    off = undefined;
    const view = values[0];
    if (view === undefined) {
      out.set(initial);
      present.set(false);
      return;
    }
    const group = pick(view);
    off = group.subscribe(() => out.set(group.get()));
    present.set(true);
  });
  return {
    get: out.get,
    subscribe: out.subscribe,
    present,
    dispose() {
      offSlot();
      off?.();
      out.dispose();
      present.dispose();
    },
  };
}

/** Follows a plain slot of `{ id, order }` entries, sorted — for action lists a model republishes. */
export function followList<T extends { id: string; order?: number }>(
  slots: Slots,
  slot: SlotDeclaration<T>,
): Readable<readonly T[]> & { dispose(): void } {
  const out = cell<readonly T[]>([]);
  const off = slots.observe(slot, (values) =>
    out.set(
      [...values].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)),
    ),
  );
  return {
    get: out.get,
    subscribe: out.subscribe,
    dispose() {
      off();
      out.dispose();
    },
  };
}
