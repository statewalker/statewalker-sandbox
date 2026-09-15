import type { KeyedSlotDeclaration, SlotDeclaration, SlotsReader } from "@sys/extension-points";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

const SlotsContext = createContext<SlotsReader | null>(null);

/** Gives renderers read access to the slots bus. The host wraps every region in one. */
export function SlotsProvider({ slots, children }: { slots: SlotsReader; children: ReactNode }) {
  return <SlotsContext.Provider value={slots}>{children}</SlotsContext.Provider>;
}

export function useSlots(): SlotsReader {
  const slots = useContext(SlotsContext);
  if (!slots) throw new Error("useSlots: no SlotsProvider above this component");
  return slots;
}

/** The live entries of a keyed slot, by id. The snapshot keeps its identity until the slot changes. */
export function useKeyedSlot<T>(declaration: KeyedSlotDeclaration<T>): ReadonlyMap<string, T> {
  const slots = useSlots();
  const subscribe = useCallback(
    (onChange: () => void) => slots.observe(declaration, () => onChange()),
    [slots, declaration],
  );
  const read = useCallback(() => slots.getSnapshot(declaration), [slots, declaration]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The live contributions of a plain slot. The snapshot keeps its identity until the slot changes. */
export function useSlot<T>(declaration: SlotDeclaration<T>): readonly T[] {
  const slots = useSlots();
  const subscribe = useCallback(
    (onChange: () => void) => slots.observe(declaration, () => onChange()),
    [slots, declaration],
  );
  const read = useCallback(() => slots.getSnapshot(declaration), [slots, declaration]);
  return useSyncExternalStore(subscribe, read, read);
}
