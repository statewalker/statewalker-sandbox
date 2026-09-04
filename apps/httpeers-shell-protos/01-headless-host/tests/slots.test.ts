// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §2 (plain accumulate vs
// keyed id-addressed, collision-throw, `View` has no `id` field)
// DERIVED-FROM-NOTE: 08-The Prototype Ladder.md §4 (the three-way split:
// "does anyone enumerate this?" is the test that decides)

import { describe, expect, it } from "vitest";
import { getSlots, newAppContext, newShellContext } from "../src/context.js";
import {
  keybindingsSlot,
  type MenuItem,
  menuItemsSlot,
  statusItemsSlot,
  type View,
  viewsSlot,
} from "../src/slots.js";

const view = (title: string): View => ({
  title,
  mount() {
    /* headless: nothing to mount into */
  },
});

describe("criterion 2 — contributions register without executing application code", () => {
  it("a menu contribution resolves nothing at registration time", () => {
    const shell = newShellContext();
    const slots = getSlots(shell);
    const item: MenuItem = {
      location: "explorer:context",
      command: "app:never-registered",
      when: 'selection("file")',
    };
    slots.provide(menuItemsSlot, item);
    const [stored] = slots.getSnapshot(menuItemsSlot);
    // The command key is still an unresolved string and `when` is still an
    // unevaluated string. Nothing looked either of them up.
    expect(stored?.command).toBe("app:never-registered");
    expect(stored?.when).toBe('selection("file")');
  });

  it("registering a view never calls mount", () => {
    const shell = newShellContext();
    let mounted = 0;
    getSlots(shell).register(viewsSlot, "notes.outline", {
      title: "Outline",
      mount() {
        mounted++;
      },
    });
    expect(mounted).toBe(0);
  });
});

describe("plain slots accumulate", () => {
  it("keeps contributions in insertion order", () => {
    const slots = getSlots(newShellContext());
    slots.provide(menuItemsSlot, { location: "l", command: "a" });
    slots.provide(menuItemsSlot, { location: "l", command: "b" });
    expect(slots.getSnapshot(menuItemsSlot).map((i) => i.command)).toEqual([
      "a",
      "b",
    ]);
  });

  it("disposal removes exactly the disposed contribution", () => {
    const slots = getSlots(newShellContext());
    const a: MenuItem = { location: "l", command: "a" };
    const b: MenuItem = { location: "l", command: "b" };
    const disposeA = slots.provide(menuItemsSlot, a);
    slots.provide(menuItemsSlot, b);
    disposeA();
    expect(slots.getSnapshot(menuItemsSlot)).toEqual([b]);
  });

  it("notifies observers on provide and on dispose", () => {
    const slots = getSlots(newShellContext());
    const seen: number[] = [];
    slots.observe(statusItemsSlot, (items) => seen.push(items.length));
    const dispose = slots.provide(statusItemsSlot, { text: "connected" });
    dispose();
    expect(seen).toEqual([0, 1, 0]);
  });

  it("the four slots are separate namespaces", () => {
    const slots = getSlots(newShellContext());
    slots.provide(menuItemsSlot, { location: "l", command: "a" });
    slots.provide(keybindingsSlot, { key: "ctrl+p", command: "shell:palette:show" });
    expect(slots.getSnapshot(menuItemsSlot)).toHaveLength(1);
    expect(slots.getSnapshot(keybindingsSlot)).toHaveLength(1);
    expect(slots.getSnapshot(statusItemsSlot)).toHaveLength(0);
  });
});

describe("keyed slots are id-addressed", () => {
  it("`View` carries no id — the id is a separate argument to register", () => {
    const slots = getSlots(newShellContext());
    const outline = view("Outline");
    slots.register(viewsSlot, "notes.outline", outline);
    expect(slots.get(viewsSlot, "notes.outline")).toBe(outline);
    expect("id" in outline).toBe(false);
  });

  it("throws on a colliding id with a different value", () => {
    const slots = getSlots(newShellContext());
    slots.register(viewsSlot, "notes.outline", view("Outline"));
    expect(() =>
      slots.register(viewsSlot, "notes.outline", view("Different")),
    ).toThrow(RangeError);
  });

  it("re-registering the same value under the same id is ref-counted", () => {
    const slots = getSlots(newShellContext());
    const outline = view("Outline");
    const d1 = slots.register(viewsSlot, "notes.outline", outline);
    const d2 = slots.register(viewsSlot, "notes.outline", outline);
    d1();
    expect(slots.get(viewsSlot, "notes.outline")).toBe(outline);
    d2();
    expect(slots.get(viewsSlot, "notes.outline")).toBeNull();
  });

  it("disposal removes the entry", () => {
    const slots = getSlots(newShellContext());
    const dispose = slots.register(viewsSlot, "notes.outline", view("Outline"));
    dispose();
    expect(slots.get(viewsSlot, "notes.outline")).toBeNull();
    expect(slots.getSnapshot(viewsSlot).size).toBe(0);
  });
});

describe("one bus, many apps", () => {
  it("a contribution made through an app context lands on the shell's bus", () => {
    const shell = newShellContext();
    const app = newAppContext(shell, {
      id: "notes",
      origin: "https://notes.example/",
    });
    getSlots(app).provide(menuItemsSlot, { location: "l", command: "a" });
    expect(getSlots(shell).getSnapshot(menuItemsSlot)).toHaveLength(1);
  });
});
