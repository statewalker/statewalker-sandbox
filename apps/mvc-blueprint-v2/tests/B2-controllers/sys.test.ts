import { Commands } from "@statewalker/shared-commands";
import { Slots } from "@statewalker/shared-slots";
import {
  type AppContext,
  atLeast,
  defineViewKind,
  dialogsSlot,
  getCommands,
  getSlots,
  loggerBackendsSlot,
  panelsSlot,
  progressSlot,
  runningOperationsSlot,
  setCommands,
  setSlots,
  shallowEqual,
} from "@sys";
import { describe, expect, it } from "vitest";

describe("B2 · sys core", () => {
  it("adapters throw when a service was never set — a controller that runs too early fails loudly", () => {
    const ctx: AppContext = {};
    expect(() => getCommands(ctx)).toThrow(/Adapter not found: sys:commands/);
    expect(() => getSlots(ctx)).toThrow(/Adapter not found: sys:slots/);
  });

  it("adapters return what was set, and do not inherit through a `parent` property", () => {
    const commands = new Commands();
    const slots = new Slots();
    const ctx: AppContext = {};
    setCommands(ctx, commands);
    setSlots(ctx, slots);
    expect(getCommands(ctx)).toBe(commands);
    expect(getSlots(ctx)).toBe(slots);
    expect(() => getSlots({ parent: ctx })).toThrow(/Adapter not found/);
  });

  it("declares each extension point under its documented key and kind", () => {
    expect([panelsSlot.key, panelsSlot._kind]).toEqual(["ui:panels", "keyed"]);
    expect([dialogsSlot.key, dialogsSlot._kind]).toEqual(["ui:dialogs", "plain"]);
    expect([progressSlot.key, progressSlot._kind]).toEqual(["ui:progress", "plain"]);
    expect([loggerBackendsSlot.key, loggerBackendsSlot._kind]).toEqual([
      "sys:logger-backends",
      "plain",
    ]);
    expect([runningOperationsSlot.key, runningOperationsSlot._kind]).toEqual([
      "ops:running",
      "plain",
    ]);
  });

  it("atLeast orders levels by severity", () => {
    expect(atLeast("warn", "info")).toBe(true);
    expect(atLeast("info", "info")).toBe(true);
    expect(atLeast("debug", "info")).toBe(false);
    expect(atLeast("fatal", "trace")).toBe(true);
  });

  it("shallowEqual compares one level deep, by identity", () => {
    const item = { id: 1 };
    expect(shallowEqual([item], [item])).toBe(true);
    expect(shallowEqual([item], [{ id: 1 }])).toBe(false);
    expect(shallowEqual({ a: 1, b: item }, { b: item, a: 1 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(shallowEqual([1], { 0: 1 })).toBe(false);
  });

  it("a view kind is a frozen token carrying its id", () => {
    const kind = defineViewKind<{ x: number }>("demo:kind");
    expect(kind.id).toBe("demo:kind");
    expect(Object.isFrozen(kind)).toBe(true);
  });

  it("a keyed panel slot refuses a second, different panel under the same id", () => {
    const slots = new Slots();
    const kind = defineViewKind<object>("demo:panel");
    slots.register(panelsSlot, "p", { kind, title: "A", placement: "main", model: {} });
    expect(() =>
      slots.register(panelsSlot, "p", { kind, title: "B", placement: "main", model: {} }),
    ).toThrow(RangeError);
  });
});
