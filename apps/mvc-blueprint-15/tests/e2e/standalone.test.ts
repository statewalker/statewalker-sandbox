import { afterEach, describe, expect, it } from "vitest";
import { contactsStandalone, todosStandalone } from "../../src/apps/workbenches.js";
import { open, type Page } from "./dom.js";
import { contactsEdit, q, todosBasics } from "./scenarios.js";

describe.each(["react", "solid"] as const)("standalone runs, %s shell (Chromium)", (tech) => {
  let page: Page | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  it("todos.standalone: the Todos scenario; only the Todos menu group", async () => {
    page = await open(todosStandalone(tech));
    await todosBasics(page);
    expect(q(page).menuGroups()).toEqual(["Todos"]);
  });

  it("contacts.standalone: the Contacts scenario; only the Contacts menu group", async () => {
    page = await open(contactsStandalone(tech));
    await contactsEdit(page);
    expect(q(page).menuGroups()).toEqual(["Contacts"]);
  });
});
