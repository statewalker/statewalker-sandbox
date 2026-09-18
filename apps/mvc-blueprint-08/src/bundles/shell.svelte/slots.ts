import type { KernelSlots, KeyedSlotDeclaration, SlotDeclaration } from "@kernel";
import { modelStore } from "@kit/svelte";
import type { Readable } from "svelte/store";

export type Slots = Pick<KernelSlots, "observe" | "getSnapshot">;

/** A slot as a Svelte store: the slots bus keeps the model contract, so the same binding applies. */
export function slotStore<T>(slots: Slots, decl: SlotDeclaration<T>): Readable<readonly T[]>;
export function slotStore<T>(
  slots: Slots,
  decl: KeyedSlotDeclaration<T>,
): Readable<ReadonlyMap<string, T>>;
export function slotStore(
  slots: Slots,
  decl: SlotDeclaration<unknown> | KeyedSlotDeclaration<unknown>,
): Readable<unknown> {
  const d = decl as SlotDeclaration<unknown>;
  return modelStore(
    () => slots.getSnapshot(d),
    (cb) => slots.observe(d, () => cb()),
  );
}

/**
 * The last element that received focus. The browser blurs an opener that gets disabled while its
 * dialog is open (Clear completed shows `running`), so `activeElement` at open time can be <body>.
 */
let lastFocused: Element | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("focusin", (event) => {
    if (!(event.target as Element).closest?.('[role="dialog"]'))
      lastFocused = event.target as Element;
  });
}

/** A Svelte action: remembers the opener when a dialog appears; puts focus back when it goes. */
export function focusReturn(_node: HTMLElement) {
  const opener = document.activeElement !== document.body ? document.activeElement : lastFocused;
  return {
    destroy() {
      // After the withdrawal has rendered: the opener may have been disabled while the dialog ran.
      setTimeout(() => {
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      }, 0);
    },
  };
}
