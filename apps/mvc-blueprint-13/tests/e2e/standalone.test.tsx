import { afterEach, describe, expect, it } from "vitest";
import { contactsReactStandalone, todosReactStandalone } from "../../src/apps/react.js";
import { contactsSolidStandalone, todosSolidStandalone } from "../../src/apps/solid.js";
import { open, type Page } from "./dom.js";
import { contactsEdit, q, todosBasics } from "./scenarios.js";

const technologies = [
  ["react", todosReactStandalone, contactsReactStandalone],
  ["solid", todosSolidStandalone, contactsSolidStandalone],
] as const;

describe.each(technologies)("standalone runs, %s (Chromium)", (_tech, todosApp, contactsApp) => {
  let page: Page | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  it("todos.standalone: the Todos scenario; only the Todos menu group", async () => {
    page = await open(todosApp);
    await todosBasics(page);
    expect(q(page).menuGroups()).toEqual(["Todos"]);
    expect(page.errors()).toEqual([]);
  });

  it("contacts.standalone: the Contacts scenario; only the Contacts menu group", async () => {
    page = await open(contactsApp);
    await contactsEdit(page);
    expect(q(page).menuGroups()).toEqual(["Contacts"]);
    expect(page.errors()).toEqual([]);
  });
});
