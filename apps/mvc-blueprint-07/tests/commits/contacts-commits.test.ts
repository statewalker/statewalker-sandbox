import { afterEach, describe, expect, it } from "vitest";
import type { ContactSelectionView } from "../../src/bundles/contacts/api/index.js";
import { selectionSlot } from "../../src/bundles/contacts/api/index.js";
import { type Probe, start } from "../support/headless.js";
import { contactAction, contactEditor, contactList, editor, recordsOf } from "../support/todos.js";

let app: Probe;
afterEach(async () => app?.stop());

const selected = (app: Probe) =>
  (app.slots.getSnapshot(selectionSlot)[0] as ContactSelectionView).getSelected();

describe("contacts editor", () => {
  it("selecting publishes details; Edit seeds the form from the stored contact", async () => {
    app = await start();
    expect(app.panel("contacts:details")).toBeUndefined();
    contactList(app).select("c1");
    expect(app.panel("contacts:details")).toBeDefined();
    contactAction(app, "Edit").submit();
    expect(contactEditor(app, "c1")?.getDraft()).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.org",
      phone: "+44 1815 1210",
    });
  });

  it("commit time: the store receives the draft at submit, not later keystrokes", async () => {
    app = await start(undefined, { contactDelay: 10 });
    contactList(app).select("c2");
    app.menu("Edit contact")?.submit();
    const form = contactEditor(app, "c2");
    form?.editField("email", "turing@example.org");
    form?.save.submit();
    form?.editField("email", "late@example.org");
    await app.log.idle();
    expect(app.contactApi.calls.find((c) => c.op === "update")?.args[1]).toMatchObject({
      email: "turing@example.org",
    });
    expect(contactEditor(app, "c2")).toBeUndefined();
    expect(app.toasts()).toEqual([{ message: "Saved", tone: "success" }]);
  });

  it("an empty name fails: error on the form and an error notification; fixing it saves", async () => {
    app = await start();
    contactList(app).select("c3");
    contactAction(app, "Edit").submit();
    const form = contactEditor(app, "c3");
    form?.editField("name", "  ");
    form?.save.submit();
    await app.log.idle();
    expect(form?.getStatus().error).toBe("Name must not be empty");
    expect(app.toasts()).toEqual([
      { message: "Could not save: Name must not be empty", tone: "error" },
    ]);
    form?.editField("name", "Rear Admiral Hopper");
    form?.save.submit();
    await app.log.idle();
    expect(contactEditor(app, "c3")).toBeUndefined();
    expect(selected(app)?.name).toBe("Rear Admiral Hopper");
  });
});

describe("interaction (1): New todo for this contact", () => {
  it("enabled follows the selection; submit reads the selection at commit time", async () => {
    app = await start();
    const link = contactAction(app, "New todo for this contact");
    expect(link.getState().enabled).toBe(false);
    contactList(app).select("c1");
    expect(link.getState().enabled).toBe(true);
    link.submit();
    contactList(app).select("c2"); // after the commit: belongs to nothing
    expect(recordsOf(app, "todos:compose").map((r) => r.payload)).toEqual([
      { title: "Ada Lovelace" },
    ]);
    expect(editor(app, "new")?.getDraft().title).toBe("Ada Lovelace");
    expect(recordsOf(app, "todos:compose")[0]?.origin).toBe("todos.contacts-link");
  });
});
