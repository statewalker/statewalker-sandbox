import { without } from "@p5/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { workbenchReact } from "../../src/apps/react.js";
import { workbenchSolid } from "../../src/apps/solid.js";
import { button, click, open, type Page, waitFor } from "./dom.js";
import {
  contactsEdit,
  headerCount,
  menus,
  newTodoForContact,
  q,
  renameTodo,
  todosBasics,
} from "./scenarios.js";

/** The same scenarios, per UI technology. Adding a technology adds a row here, nothing else. */
const technologies = [
  ["react", workbenchReact],
  ["solid", workbenchSolid],
] as const;

describe.each(technologies)("workbench.%s (Chromium)", (_tech, manifest) => {
  let page: Page | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  it("Todos: add, toggle, edit and save, clear completed", async () => {
    page = await open(manifest);
    await todosBasics(page);
  });

  it("Contacts: edit, failing save, save", async () => {
    page = await open(manifest);
    await contactsEdit(page);
  });

  it("(1) New todo for this contact", async () => {
    page = await open(manifest);
    await newTodoForContact(page);
  });

  it("(2) the header count follows the collection", async () => {
    page = await open(manifest);
    await headerCount(page);
  });

  it("(3) one main menu with both apps' groups", async () => {
    page = await open(manifest);
    await menus(page, ["Contacts", "Hello", "Todos"]);
  });

  it("(3) removing Contacts removes its group and nothing else", async () => {
    page = await open(without(manifest, "contacts").manifest);
    await menus(page, ["Hello", "Todos"]);
    await todosBasics(page);
  });

  it("(3) removing Todos removes its group, panels and header item", async () => {
    page = await open(without(manifest, "todos").manifest);
    await menus(page, ["Contacts", "Hello"]);
    expect(q(page).header()).toEqual([]);
    await contactsEdit(page);
  });

  it("Ctrl-click adds and removes a row (the model's toggleSelected, no arithmetic in the view)", async () => {
    page = await open(manifest);
    const $ = q(page);
    await waitFor(() => $.todoTitles().length === 3);
    const selected = () =>
      $.todoTitles().filter((t) => $.todoRow(t)?.getAttribute("aria-current") === "true");
    click($.todoRow("Buy milk"));
    await waitFor(() => selected().join() === "Buy milk");
    click($.todoRow("Call plumber"), { ctrlKey: true });
    await waitFor(() => selected().join() === "Buy milk,Call plumber");
    click($.todoRow("Buy milk"), { metaKey: true });
    await waitFor(() => selected().join() === "Call plumber");
  });

  it("Rename a todo", async () => {
    page = await open(manifest);
    await renameTodo(page);
  });

  it("hello: the minimal bundle's menu item and panel", async () => {
    page = await open(manifest);
    const $ = q(page);
    await waitFor(() => $.tab("Hello") !== undefined);
    click($.menuItem("Say hello"));
    await waitFor(() => page?.root.querySelector("[data-hello-count]")?.textContent === "Count: 1");
  });

  it("dialog: focus returns to the opener on withdrawal", async () => {
    page = await open(manifest);
    const $ = q(page);
    await waitFor(() => $.todoTitles().length === 3);
    const clear = button(
      $.panel("todos:list") as HTMLElement,
      "Clear completed",
    ) as HTMLButtonElement;
    clear.focus();
    click(clear);
    await waitFor(() => $.dialog("todos:clear-completed") !== null);
    click(button($.dialog("todos:clear-completed") as HTMLElement, "Cancel"));
    await waitFor(() => $.dialog("todos:clear-completed") === null);
    await waitFor(() => document.activeElement === clear);
  });
});
