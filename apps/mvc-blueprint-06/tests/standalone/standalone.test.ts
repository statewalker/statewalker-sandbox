import { describe, expect, it } from "vitest";
import { contactsHeadless, todosHeadless } from "../../src/apps/index.js";
import {
  contactsBasics,
  headerCount,
  todosBasics,
  todosEditorFailureAndCancel,
} from "../scenario/scenario.js";
import { start } from "../support/headless.js";

describe("standalone runs in the test shell", () => {
  it("Todos alone: its suite passes; nothing of Contacts exists", async () => {
    for (const run of [todosBasics, todosEditorFailureAndCancel, headerCount]) {
      const h = await start(todosHeadless({ notifyTimeoutMs: 60_000 }));
      await run(h);
      expect(h.menuGroups()).toEqual(["Todos"]);
      expect(h.system.addresses().some((a) => a.startsWith("contacts"))).toBe(false);
      expect(h.errors()).toEqual([]);
      await h.stop();
    }
  });

  it("Contacts alone: its suite passes; the link's action is simply absent", async () => {
    const h = await start(contactsHeadless({ notifyTimeoutMs: 60_000 }));
    await contactsBasics(h);
    const actions =
      h.view<{ actions: { action: { label: string } }[] }>("contacts:details")?.actions ?? [];
    expect(actions.map((a) => a.action.label)).toEqual(["Edit"]);
    expect(h.menuGroups()).toEqual(["Contacts"]);
    expect(h.errors()).toEqual([]);
    await h.stop();
  });
});
