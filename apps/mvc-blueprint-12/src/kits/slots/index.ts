import { type KernelSlots, type SlotDeclaration, signal, untracked } from "@kernel";

/**
 * Follows the first contribution of a one-contribution slot (shared state such as
 * `todos:collection`): `attach(item)` runs when it appears or is replaced and returns its detach;
 * `none()` runs when there is none. Order-independent: works whether the owner is already there.
 */
export function followFirst<T>(
  slots: Pick<KernelSlots, "observe">,
  decl: SlotDeclaration<T>,
  attach: (item: T) => () => void,
  none: () => void = () => {},
): () => void {
  let current: T | undefined;
  let detach: (() => void) | undefined;
  const off = slots.observe(decl, (items) => {
    const next = items[0];
    if (next === current) return;
    detach?.();
    detach = undefined;
    current = next;
    if (next === undefined) none();
    else detach = attach(next);
  });
  return () => {
    off();
    detach?.();
    detach = undefined;
  };
}

/** Contributions with an `order` and an `id`, by order then id. Returns a new array. */
export function byOrder<T extends { readonly order: number; readonly id: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * P4: the first contribution of a one-contribution slot as a tracked read on the kernel graph, so
 * a `computed` (or an action's `when`) can follow shared state through its arrival, replacement
 * and withdrawal: `computed(() => collection()?.counts().open ?? 0)`. Returns the read and its stop.
 */
export function firstOf<T>(
  slots: Pick<KernelSlots, "observe">,
  decl: SlotDeclaration<T>,
): readonly [read: () => T | undefined, stop: () => void] {
  const current = signal<T | undefined>(undefined);
  const off = slots.observe(decl, (items) => {
    if (items[0] !== untracked(current)) current(items[0]);
  });
  return [current, off];
}
