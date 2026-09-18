import type { Slots } from "../../kernel/slots.js";
import { dialogsSlot, panelsSlot } from "../shell/api/index.js";
import { reactRenderersSlot } from "../shell/api/react.js";

export interface CoverageGap {
  readonly slot: string;
  readonly id: string;
  readonly kind: string;
}

/** Contributions in shell:panels and shell:dialogs with no React renderer for their kind (§9). */
export function coverageReport(slots: Slots): readonly CoverageGap[] {
  const renderers = slots.getSnapshot(reactRenderersSlot);
  const gaps: CoverageGap[] = [];
  for (const slot of [panelsSlot, dialogsSlot]) {
    for (const [id, entry] of slots.getSnapshot(slot)) {
      if (!renderers.has(entry.kind.id)) gaps.push({ slot: slot.key, id, kind: entry.kind.id });
    }
  }
  return gaps;
}
