import { expect } from "vitest";
import { all, button, click, type Page, typeInto, waitFor } from "./dom.js";

/** Page queries shared by every technology: the markup contract of the shell and renderers. */
export const q = (page: Page) => {
  const root = page.root;
  return {
    tab: (name: string) => all(root, '[role="tab"]').find((t) => t.textContent === name),
    tabs: () => all(root, '[role="tab"]').map((t) => t.textContent),
    panel: (id: string) => root.querySelector<HTMLElement>(`[data-panel="${id}"]`),
    todoTitles: () =>
      all(root, '[data-panel="todos:list"] [data-todo] span').map((s) => s.textContent),
    todoRow: (title: string) =>
      all(root, "[data-todo]").find((li) => li.querySelector("span")?.textContent === title),
    header: () => all(root, "[data-header-item]").map((h) => h.textContent),
    menuGroups: () =>
      all(root, "[data-menu-group] summary")
        .map((s) => s.textContent)
        .sort(),
    menuItem: (label: string) =>
      all<HTMLButtonElement>(root, '[role="menuitem"]').find((b) => b.textContent === label),
    dialog: (id: string) => root.querySelector<HTMLElement>(`[data-dialog="${id}"]`),
    toasts: () => all(root, "[data-notification]").map((n) => n.querySelector("span")?.textContent),
    contactRow: (name: string) => all(root, "[data-contact]").find((li) => li.textContent === name),
  };
};

export async function todosBasics(page: Page): Promise<void> {
  const $ = q(page);
  await waitFor(() => $.todoTitles().length === 3);
  // Elements are re-queried at every step: a host may re-create them (the trivial test shell does).
  const list = () => $.panel("todos:list") as HTMLElement;
  typeInto(list().querySelector('input[aria-label="New todo"]'), "Call mum");
  await waitFor(() => button(list(), "Add")?.disabled === false);
  click(button(list(), "Add"));
  await waitFor(() => $.todoTitles().includes("Call mum"));
  await waitFor(
    () => (list().querySelector('input[aria-label="New todo"]') as HTMLInputElement).value === "",
  );

  click(list().querySelector('input[aria-label="Done: Buy milk"]'));
  await waitFor(
    () => $.todoRow("Buy milk")?.querySelector("span")?.className.includes("line-through") === true,
  );

  click($.todoRow("Write report"));
  await waitFor(() => button(list(), "Edit")?.disabled === false);
  click(button(list(), "Edit"));
  await waitFor(() => $.panel("todos:editor") !== null);
  const editor = () => $.panel("todos:editor") as HTMLElement;
  typeInto(editor().querySelector('input[aria-label="Title"]'), "Write the report");
  await waitFor(() => button(editor(), "Save")?.disabled === false);
  click(button(editor(), "Save"));
  await waitFor(() => $.panel("todos:editor") === null);
  await waitFor(() => $.todoTitles().includes("Write the report"));
  await waitFor(() => $.toasts().some((t) => t?.startsWith("Saved")));

  click(button(list(), "Clear completed"));
  await waitFor(() => $.dialog("todos:clear-completed") !== null);
  const dialog = () => $.dialog("todos:clear-completed") as HTMLElement;
  expect(dialog().textContent).toContain("Delete 2 completed todos?");
  click(button(dialog(), "Clear"));
  await waitFor(() => $.dialog("todos:clear-completed") === null);
  await waitFor(() => $.todoTitles().length === 2);
  await waitFor(() => $.toasts().includes("Cleared 2 completed todos"));
  expect(page.errors()).toEqual([]);
}

/** (1) "New todo for this contact" — from the Contacts list into the Todos editor. */
export async function newTodoForContact(page: Page): Promise<void> {
  const $ = q(page);
  await waitFor(() => $.tab("Contacts") !== undefined);
  click($.tab("Contacts"));
  await waitFor(() => $.contactRow("Grace Hopper") !== undefined);
  const contacts = () => $.panel("contacts:list") as HTMLElement;
  await waitFor(() => $.panel("contacts:list")?.hidden === false);
  expect(button(contacts(), "New todo for this contact")?.disabled).toBe(true);
  click($.contactRow("Grace Hopper"));
  await waitFor(
    () => $.panel("contacts:details")?.textContent?.includes("grace@example.org") === true,
  );
  await waitFor(() => button(contacts(), "New todo for this contact")?.disabled === false);
  click(button(contacts(), "New todo for this contact"));
  await waitFor(() => $.panel("todos:editor") !== null);
  const editor = () => $.panel("todos:editor") as HTMLElement;
  expect((editor().querySelector('input[aria-label="Title"]') as HTMLInputElement).value).toBe(
    "Grace Hopper",
  );
  click(button(editor(), "Save"));
  await waitFor(() => $.panel("todos:editor") === null);
  click($.tab("Todos"));
  await waitFor(() => $.todoTitles().includes("Grace Hopper"));
  expect(page.errors()).toEqual([]);
}

/** (2) The header count follows the collection with no command. */
export async function headerCount(page: Page): Promise<void> {
  const $ = q(page);
  await waitFor(() => $.header().includes("2 open todos"));
  const list = () => $.panel("todos:list") as HTMLElement;
  click(list().querySelector('input[aria-label="Done: Buy milk"]'));
  await waitFor(() => $.header().includes("1 open todos"));
  typeInto(list().querySelector('input[aria-label="New todo"]'), "Another");
  await waitFor(() => button(list(), "Add")?.disabled === false);
  click(button(list(), "Add"));
  await waitFor(() => $.header().includes("2 open todos"));
}

/** (3) Both apps' groups in one menu; the menu drives the apps. */
export async function menus(page: Page, groups: string[]): Promise<void> {
  const $ = q(page);
  await waitFor(() => $.menuGroups().length === groups.length);
  expect($.menuGroups()).toEqual(groups);
  if (groups.includes("Todos")) {
    click($.menuItem("New todo…"));
    await waitFor(() => $.panel("todos:editor") !== null);
    click(button($.panel("todos:editor") as HTMLElement, "Cancel"));
    await waitFor(() => $.panel("todos:editor") === null);
  }
  if (groups.includes("Contacts")) {
    await waitFor(() => $.menuItem("Edit contact") !== undefined);
    expect($.menuItem("Edit contact")?.disabled).toBe(true);
  }
  expect(page.errors()).toEqual([]);
}

/** Contacts: edit, a failing save (empty name), then a good one. */
export async function contactsEdit(page: Page): Promise<void> {
  const $ = q(page);
  await waitFor(() => $.contactRow("Alan Turing") !== undefined);
  if ($.tab("Contacts")) click($.tab("Contacts"));
  click($.contactRow("Alan Turing"));
  const contacts = () => $.panel("contacts:list") as HTMLElement;
  await waitFor(() => button(contacts(), "Edit")?.disabled === false);
  click(button(contacts(), "Edit"));
  await waitFor(() => $.panel("contacts:editor") !== null);
  const editor = () => $.panel("contacts:editor") as HTMLElement;
  expect((editor().querySelector('input[aria-label="Name"]') as HTMLInputElement).value).toBe(
    "Alan Turing",
  );
  typeInto(editor().querySelector('input[aria-label="Name"]'), "");
  await waitFor(() => button(editor(), "Save")?.disabled === false);
  click(button(editor(), "Save"));
  await waitFor(() => editor().querySelector('[role="alert"]')?.textContent === "Name is required");
  await waitFor(() => all(page.root, '[data-notification][role="alert"]').length === 1);
  typeInto(editor().querySelector('input[aria-label="Name"]'), "Alan M. Turing");
  await waitFor(() => button(editor(), "Save")?.disabled === false);
  click(button(editor(), "Save"));
  await waitFor(() => $.panel("contacts:editor") === null);
  await waitFor(() => $.contactRow("Alan M. Turing") !== undefined);
  await waitFor(() => $.toasts().some((t) => t?.startsWith("Saved")));
  expect(page.errors()).toEqual([]);
}
