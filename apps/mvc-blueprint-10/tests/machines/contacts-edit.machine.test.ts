import { describe, expect, it } from "vitest";
import { contactEditorChart } from "../../src/bundles/contacts.edit/machine.js";
import { drive, trace } from "./trace.js";

describe("contacts.edit chart (no DOM, no kernel)", () => {
  it("open → save → failed → save → saved; a save while saving is dropped", async () => {
    const { machine } = await trace(contactEditorChart);
    expect(await drive(machine, "open", "save", "save", "failed", "save", "saved")).toEqual([
      "contacts.edit/open/editing",
      "contacts.edit/open/saving",
      "contacts.edit/open/saving",
      "contacts.edit/open/editing",
      "contacts.edit/open/saving",
      "contacts.edit/closed",
    ]);
  });

  it("opening another contact replaces the session, from any open state", async () => {
    const { machine, log } = await trace(contactEditorChart);
    await drive(machine, "open");
    log.length = 0;
    await drive(machine, "open");
    expect(log).toEqual(["-editing", "-open", "+open(open)", "+editing(open)"]);
  });

  it("cancel closes; stop exits everything", async () => {
    const { machine, log } = await trace(contactEditorChart);
    expect(await drive(machine, "open", "cancel")).toEqual([
      "contacts.edit/open/editing",
      "contacts.edit/closed",
    ]);
    log.length = 0;
    await machine.stop();
    expect(log).toEqual(["-closed", "-contacts.edit"]);
  });
});
