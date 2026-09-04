// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §3 (resolveMenu's
// signature, the filter-evaluate-sort order, "called on every render, does not
// cache")
// DERIVED-FROM-NOTE: 03-The VS Code Contribution Model.md §1 and §3
// ("navigation" pins to the top; groups sort lexicographically; a numeric
// `order` field instead of VS Code's unreliable `group@N` suffix)
//
// RECONSTRUCTED, NOT RECOVERED.

import { getEnablement, getSlots, type HostContext } from "./context.js";
import { type MenuItem, menuItemsSlot } from "./slots.js";

/** `navigation` is pinned above every other group. */
const PINNED_GROUP = "navigation";

/**
 * Ungrouped entries sort as the empty group: above every named group, below
 * `navigation`. The notes fix `navigation` first and "remaining groups
 * lexicographic" but say nothing about `group: undefined`; the empty string is
 * the reading that keeps one comparison rule instead of two.
 */
function groupRank(item: MenuItem): [number, string] {
  const group = item.group ?? "";
  return group === PINNED_GROUP ? [0, ""] : [1, group];
}

/**
 * Resolve the menu for one location.
 *
 * Filters by location, evaluates each `when` against the *current* fact set,
 * then sorts: `navigation` group first, remaining groups lexicographic,
 * `order` ascending within a group, contribution order as the final tiebreak.
 *
 * Called on every render. Does not cache — that is what makes a contribution
 * registered once, unconditionally, appear and disappear as facts change.
 */
export function resolveMenu(ctx: HostContext, location: string): MenuItem[] {
  const slots = getSlots(ctx);
  const enablement = getEnablement(ctx);

  const candidates: { item: MenuItem; seq: number }[] = [];
  let seq = 0;
  for (const item of slots.getSnapshot(menuItemsSlot)) {
    const index = seq++;
    if (item.location !== location) continue;
    if (!enablement.evaluate(item.when)) continue;
    candidates.push({ item, seq: index });
  }

  candidates.sort((a, b) => {
    const [aPin, aGroup] = groupRank(a.item);
    const [bPin, bGroup] = groupRank(b.item);
    if (aPin !== bPin) return aPin - bPin;
    if (aGroup !== bGroup) return aGroup < bGroup ? -1 : 1;
    const aOrder = a.item.order ?? 0;
    const bOrder = b.item.order ?? 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.seq - b.seq;
  });

  return candidates.map((c) => c.item);
}
