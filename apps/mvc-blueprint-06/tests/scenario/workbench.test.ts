import { afterEach, describe, expect, it } from "vitest";
import { workbenchHeadless } from "../../src/apps/index.js";
import { type Harness, start } from "../support/headless.js";
import {
  contactsBasics,
  headerCount,
  newTodoForContact,
  todosBasics,
  todosEditorFailureAndCancel,
} from "./scenario.js";

describe("§14 scenario · headless workbench", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    expect(h?.errors()).toEqual([]);
    await h?.stop();
    h = undefined;
  });

  it("Todos behaviour", async () => {
    h = await start(workbenchHeadless({ notifyTimeoutMs: 60_000 }));
    await todosBasics(h);
  });
  it("Todos editor: empty title refused with a form error; Cancel withdraws", async () => {
    h = await start(workbenchHeadless({ notifyTimeoutMs: 60_000 }));
    await todosEditorFailureAndCancel(h);
  });
  it("Contacts behaviour", async () => {
    h = await start(workbenchHeadless({ notifyTimeoutMs: 60_000 }));
    await contactsBasics(h);
  });
  it("(1) New todo for this contact", async () => {
    h = await start(workbenchHeadless({ notifyTimeoutMs: 60_000 }));
    await newTodoForContact(h);
  });
  it("(2) header count", async () => {
    h = await start(workbenchHeadless());
    await headerCount(h);
  });
  it("(3) both menu groups in one main menu", async () => {
    h = await start(workbenchHeadless());
    expect(h.menuGroups()).toEqual(["Todos", "Contacts"]);
  });
  it("notifications withdraw after the timeout, or on dismiss", async () => {
    h = await start(workbenchHeadless({ notifyTimeoutMs: 30 }));
    await todosBasics(h);
    const first = h.notes()[0];
    h.dispatch(first?.dismiss);
    expect(h.notes()).not.toContainEqual(first);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.notes()).toEqual([]);
  });
});
