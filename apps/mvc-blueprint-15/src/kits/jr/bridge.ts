import type { KernelSlots, KeyedSlotDeclaration } from "@kernel";

/**
 * Follows one keyed slot and mirrors every entry, converted, into another keyed slot (and withdraws
 * it with its source). How a technology's `jr.<tech>` bundle turns the neutral json-render views
 * into renderers of its own renderer slot — the shell host sees ordinary renderers.
 */
export function mirrorSlot<V, R>(
  slots: Pick<KernelSlots, "observe" | "register">,
  from: KeyedSlotDeclaration<V>,
  to: KeyedSlotDeclaration<R>,
  convert: (entry: V) => R,
): () => void {
  const mirrored = new Map<string, { from: V; off: () => void }>();
  const offObserve = slots.observe(from, (entries) => {
    for (const [key, m] of mirrored) {
      if (entries.get(key) === m.from) continue;
      m.off();
      mirrored.delete(key);
    }
    for (const [key, entry] of entries) {
      if (mirrored.has(key)) continue;
      mirrored.set(key, { from: entry, off: slots.register(to, key, convert(entry)) });
    }
  });
  return () => {
    offObserve();
    for (const m of mirrored.values()) m.off();
    mirrored.clear();
  };
}
