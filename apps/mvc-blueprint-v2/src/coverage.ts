import {
  dialogsSlot,
  panelsSlot,
  type Placement,
  progressSlot,
  type RenderQuery,
  type SlotsReader,
  type UiHost,
} from "@sys/ui";

export interface Unrendered {
  readonly slot: string;
  readonly kind: string;
  /** Present for a panel: a known kind in a placement no host has a region for is unrendered too. */
  readonly placement?: Placement;
}

/**
 * The failure slots make silent: a contribution nothing renders. A command
 * with no handler rejects; a panel with no renderer — or with a renderer but
 * no region for its placement, or a contribution sent to a slot its host does
 * not render — just never appears. This observes every `ui:*` slot, asks each
 * host whether it renders the contribution there, and reports each (slot,
 * kind, placement) no host can render, once. It only observes.
 */
export function observeCoverage(
  slots: SlotsReader,
  hosts: readonly Pick<UiHost, "renders">[],
  report: (unrendered: Unrendered) => void,
): () => void {
  const reported = new Set<string>();
  const check = (slot: string, contributions: Iterable<RenderQuery>) => {
    for (const contribution of contributions) {
      const { kind, placement } = contribution;
      const key = `${slot} ${kind.id} ${placement ?? ""}`;
      if (reported.has(key) || hosts.some((h) => h.renders(slot, contribution))) continue;
      reported.add(key);
      report(
        placement === undefined ? { slot, kind: kind.id } : { slot, kind: kind.id, placement },
      );
    }
  };
  const offs = [
    slots.observe(panelsSlot, (entries) => check(panelsSlot.key, entries.values())),
    slots.observe(dialogsSlot, (items) => check(dialogsSlot.key, items)),
    slots.observe(progressSlot, (items) => check(progressSlot.key, items)),
  ];
  return () => {
    for (const off of offs) off();
  };
}
