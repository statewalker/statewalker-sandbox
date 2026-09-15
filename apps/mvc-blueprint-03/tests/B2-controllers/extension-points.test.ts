import { Slots } from "@statewalker/shared-slots";
import { createAction } from "@sys/action";
import {
  defineViewKind,
  dialogsSlot,
  notificationsSlot,
  panelsSlot,
  sortActions,
  todosSelectionActionsSlot,
  todosToolbarActionsSlot,
} from "@sys/extension-points";
import { describe, expect, it } from "vitest";

describe("B2 · extension points", () => {
  it("declares each extension point under its documented key and kind", () => {
    expect([panelsSlot.key, panelsSlot._kind]).toEqual(["ui:panels", "keyed"]);
    expect([dialogsSlot.key, dialogsSlot._kind]).toEqual(["ui:dialogs", "plain"]);
    expect([notificationsSlot.key, notificationsSlot._kind]).toEqual(["ui:notifications", "plain"]);
    expect([todosToolbarActionsSlot.key, todosToolbarActionsSlot._kind]).toEqual([
      "actions:todos.toolbar",
      "plain",
    ]);
    expect([todosSelectionActionsSlot.key, todosSelectionActionsSlot._kind]).toEqual([
      "actions:todos.selection",
      "plain",
    ]);
  });

  it("a view kind is a frozen token carrying its id", () => {
    const kind = defineViewKind<{ x: number }>("demo:kind");
    expect(kind.id).toBe("demo:kind");
    expect(Object.isFrozen(kind)).toBe(true);
  });

  it("the keyed panel slot refuses a second, different panel under one id", () => {
    const slots = new Slots();
    const kind = defineViewKind<object>("demo:panel");
    slots.register(panelsSlot, "p", { kind, title: "A", placement: "main", model: {} });
    expect(() =>
      slots.register(panelsSlot, "p", { kind, title: "B", placement: "main", model: {} }),
    ).toThrow(RangeError);
  });

  it("sortActions orders contributions by order, then by id, without mutating the snapshot", () => {
    const a = createAction({ label: "A" }).view;
    const items = Object.freeze([
      { id: "todos.remove", order: 30, action: a },
      { id: "todos.toggle", order: 10, action: a },
      { id: "other.archive", order: 10, action: a },
    ]);
    expect(sortActions(items).map((i) => i.id)).toEqual([
      "other.archive",
      "todos.toggle",
      "todos.remove",
    ]);
    expect(items[0].id).toBe("todos.remove");
  });
});
