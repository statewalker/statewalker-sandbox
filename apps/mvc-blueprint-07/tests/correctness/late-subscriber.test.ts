import { describe, expect, it } from "vitest";
import { panelsSlot } from "../../src/bundles/shell/api/index.js";
import { contacts, shell, todos, todosContacts } from "../../src/features.js";
import { application } from "../../src/kernel/loader.js";
import { start } from "../support/headless.js";
import { contactAction, contactList } from "../support/todos.js";

describe("late subscribers", () => {
  it("a consumer activated before the owner of todos:collection still shows the count", async () => {
    const reordered = {
      ...todos,
      bundles: [...todos.bundles].sort((a) => (a.id === "todos.status" ? -1 : 1)),
    };
    expect(reordered.bundles[0]?.id).toBe("todos.status");
    const app = await start({ id: "status-first", features: [shell, reordered] });
    expect(app.header()).toEqual(["2 open todos"]);
    await app.stop();
  });

  it("the link activated before contacts.list still follows contacts:selection", async () => {
    const early = { ...todosContacts, requires: [] };
    const app = await start({ id: "link-first", features: [shell, early, todos, contacts] });
    const link = contactAction(app, "New todo for this contact");
    contactList(app).select("c1");
    expect(link.getState().enabled).toBe(true);
    await app.stop();
    expect(app.errors()).toEqual([]);
  });

  it("a feature activated after the shell appears without a reload", async () => {
    const app = await start({ id: "shell-only", features: [shell, todos] });
    expect(app.slots.get(panelsSlot, "contacts:list")).toBeNull();
    const stopLate = await application({ id: "late", features: [{ ...contacts, requires: [] }] })(
      app.context,
    );
    await app.log.idle();
    expect(
      contactList(app)
        .getItems()
        .map((c) => c.name),
    ).toContain("Ada Lovelace");
    await stopLate?.();
    expect(app.slots.get(panelsSlot, "contacts:list")).toBeNull();
    await app.stop();
  });
});
