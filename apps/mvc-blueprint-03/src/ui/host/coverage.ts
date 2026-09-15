import {
  dialogsSlot,
  notificationsSlot,
  type Placement,
  panelsSlot,
  type RenderQuery,
  type SlotsReader,
  type UiHost,
} from "@sys/extension-points";

export interface Unrendered {
  readonly slot: string;
  readonly kind: string;
  readonly placement?: Placement;
}

/**
 * The failure slots make silent: a contribution nothing renders. Observes every
 * `ui:*` slot, asks each host whether it renders the contribution there, and
 * reports each (slot, kind, placement) no host can render, once. Only observes.
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
    slots.observe(notificationsSlot, (items) => check(notificationsSlot.key, items)),
  ];
  return () => {
    for (const off of offs) off();
  };
}
