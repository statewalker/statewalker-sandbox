import { dialogsSlot, panelsSlot, progressSlot, type SlotsReader, type UiHost } from "@sys/ui";

export interface Unrendered {
  readonly slot: string;
  readonly kind: string;
}

/**
 * The failure slots make silent: a contribution nothing renders. A command
 * with no handler rejects; a panel with no renderer just never appears. This
 * observes every `ui:*` slot and reports each kind no host can render, once.
 * It only observes.
 */
export function observeCoverage(
  slots: SlotsReader,
  hosts: readonly Pick<UiHost, "kinds">[],
  report: (unrendered: Unrendered) => void,
): () => void {
  const reported = new Set<string>();
  const check = (slot: string, kinds: readonly string[]) => {
    const known = new Set(hosts.flatMap((h) => [...h.kinds()]));
    for (const kind of kinds) {
      const key = `${slot} ${kind}`;
      if (known.has(kind) || reported.has(key)) continue;
      reported.add(key);
      report({ slot, kind });
    }
  };
  const offs = [
    slots.observe(panelsSlot, (entries) =>
      check(
        panelsSlot.key,
        [...entries.values()].map((p) => p.kind.id),
      ),
    ),
    slots.observe(dialogsSlot, (items) =>
      check(
        dialogsSlot.key,
        items.map((d) => d.kind.id),
      ),
    ),
    slots.observe(progressSlot, (items) =>
      check(
        progressSlot.key,
        items.map((p) => p.kind.id),
      ),
    ),
  ];
  return () => {
    for (const off of offs) off();
  };
}
