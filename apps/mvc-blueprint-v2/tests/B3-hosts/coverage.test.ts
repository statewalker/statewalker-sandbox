import { Slots } from "@statewalker/shared-slots";
import { defineViewKind, dialogsSlot, panelsSlot, progressSlot, type RenderQuery } from "@sys/ui";
import { describe, expect, it } from "vitest";
import { observeCoverage, type Unrendered } from "../../src/coverage.js";

/**
 * A stand-in host that renders exactly the listed places, each spelled
 * "slot kind" or, for a panel, "slot kind placement". The real hosts' answers
 * are pinned in their own suites; this one pins what the observer does with them.
 */
const host = (...places: string[]) => ({
  renders: (slot: string, { kind, placement }: RenderQuery) =>
    places.includes([slot, kind.id, placement].filter(Boolean).join(" ")),
});

function observe(...hosts: ReturnType<typeof host>[]) {
  const slots = new Slots();
  const reports: Unrendered[] = [];
  const off = observeCoverage(slots, hosts, (u) => reports.push(u));
  return { slots, reports, off };
}

describe("B3 · coverage observer", () => {
  it("reports each contribution no host renders — once — and never a rendered one", () => {
    const { slots, reports, off } = observe(
      host("ui:panels known:a main"),
      host("ui:dialogs known:b"),
    );
    slots.register(panelsSlot, "p1", {
      kind: defineViewKind("known:a"),
      title: "A",
      placement: "main",
      model: {},
    });
    slots.register(panelsSlot, "p2", {
      kind: defineViewKind("nobody:renders"),
      title: "X",
      placement: "side",
      model: {},
    });
    slots.provide(dialogsSlot, { kind: defineViewKind("known:b"), model: {} });
    slots.provide(dialogsSlot, { kind: defineViewKind("nobody:dialog"), model: {} });
    slots.provide(dialogsSlot, { kind: defineViewKind("nobody:dialog"), model: {} });
    expect(reports).toEqual([
      { slot: "ui:panels", kind: "nobody:renders", placement: "side" },
      { slot: "ui:dialogs", kind: "nobody:dialog" },
    ]);
    off();
  });

  it("reports a known kind in a placement no host has a region for", () => {
    const { slots, reports, off } = observe(host("ui:panels known:a main"));
    const kind = defineViewKind("known:a");
    slots.register(panelsSlot, "here", { kind, title: "Here", placement: "main", model: {} });
    slots.register(panelsSlot, "there", { kind, title: "There", placement: "side", model: {} });
    expect(reports).toEqual([{ slot: "ui:panels", kind: "known:a", placement: "side" }]);
    off();
  });

  it("reports a known kind sent to a slot whose host does not render it", () => {
    const { slots, reports, off } = observe(host("ui:progress progress:bar"));
    const kind = defineViewKind("progress:bar");
    slots.provide(progressSlot, { kind, model: {} });
    expect(reports).toEqual([]);
    slots.provide(dialogsSlot, { kind, model: {} });
    expect(reports).toEqual([{ slot: "ui:dialogs", kind: "progress:bar" }]);
    off();
  });
});
