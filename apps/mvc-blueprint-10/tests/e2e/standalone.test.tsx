import { afterEach, describe, expect, it } from "vitest";
import { contactsStandalone } from "../../src/apps/contacts.standalone.js";
import { todosStandalone } from "../../src/apps/todos.standalone.js";
import { open, type Page } from "./dom.js";
import { contactsEdit, q, todosBasics } from "./scenarios.js";

describe("standalone runs in the trivial test shell (DOM, Chromium)", () => {
  let page: Page | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  it("todos.standalone: the Todos scenario; only the Todos menu group", async () => {
    page = await open(todosStandalone);
    await todosBasics(page);
    expect(q(page).menuGroups()).toEqual(["Todos"]);
  });

  it("contacts.standalone: the Contacts scenario; only the Contacts menu group", async () => {
    page = await open(contactsStandalone);
    await contactsEdit(page);
    expect(q(page).menuGroups()).toEqual(["Contacts"]);
  });
});
