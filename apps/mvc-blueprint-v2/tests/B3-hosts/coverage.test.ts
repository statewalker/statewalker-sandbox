import { Slots } from "@statewalker/shared-slots";
import { defineViewKind, dialogsSlot, panelsSlot } from "@sys/ui";
import { describe, expect, it } from "vitest";
import { observeCoverage, type Unrendered } from "../../src/coverage.js";

describe("B3 · coverage observer", () => {
  it("reports each contribution whose kind no host renders — once — and never a rendered one", () => {
    const slots = new Slots();
    const reports: Unrendered[] = [];
    const off = observeCoverage(
      slots,
      [{ kinds: () => ["known:a"] }, { kinds: () => ["known:b"] }],
      (u) => reports.push(u),
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
    expect(reports).toEqual([
      { slot: "ui:panels", kind: "nobody:renders" },
      { slot: "ui:dialogs", kind: "nobody:dialog" },
    ]);
    off();
  });
});
