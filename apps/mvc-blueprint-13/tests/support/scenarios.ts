import type { ContactEditorView, ContactListView } from "@p5/contacts/api";
import type { ConfirmView, TitleFormView, TodoListView } from "@p5/todos/api";
import { expect } from "vitest";
import { dialog, menuItem, panel, type Running, toasts, until } from "./harness.js";

/**
 * Headless scenario steps, driven through view facets only — what a renderer could do.
 * Shared by the standalone suites and the removal runs.
 */
export const todoList = (r: Running) => {
  const p = panel<TodoListView>(r.slots, "todos:list");
  if (!p) throw new Error("no todos:list panel");
  return p.model;
};
export const titles = (r: Running) =>
  todoList(r)
    .getItems()
    .map((t) => t.title);
export const selectionAction = (list: TodoListView, label: string) => {
  const found = list.getSelectionActions().find((a) => a.action.getState().label === label);
  if (!found) throw new Error(`no selection action "${label}"`);
  return found.action;
};
export const toolbarAction = (list: TodoListView, label: string) => {
  const found = list.getToolbar().find((a) => a.action.getState().label === label);
  if (!found) throw new Error(`no toolbar action "${label}"`);
  return found.action;
};
const byTitle = (list: TodoListView, title: string) => {
  const t = list.getItems().find((x) => x.title === title);
  if (!t) throw new Error(`no todo "${title}"`);
  return t;
};

export async function todosScenario(r: Running): Promise<void> {
  await until(() => titles(r).length === 3);
  expect(titles(r)).toEqual(["Buy milk", "Write report", "Call plumber"]);
  const list = todoList(r);

  // Add through the new-title input.
  list.setNewTitle("Call mum");
  toolbarAction(list, "Add").submit();
  await until(() => titles(r).includes("Call mum"));
  await until(() => list.getNewTitle() === "");

  // Toggle through the row checkbox gesture: select + submit in one tick.
  list.select([byTitle(list, "Buy milk").id]);
  list.toggle.submit();
  await until(() => byTitle(list, "Buy milk").done);

  // Edit → Save.
  list.select([byTitle(list, "Write report").id]);
  selectionAction(list, "Edit").submit();
  await until(() => panel(r.slots, "todos:editor") !== undefined);
  const editor = panel<TitleFormView>(r.slots, "todos:editor")?.model as TitleFormView;
  editor.editField("title", "Write the report");
  editor.save.submit();
  await until(() => panel(r.slots, "todos:editor") === undefined);
  expect(titles(r)).toContain("Write the report");
  expect(toasts(r.slots).some((t) => t.message === "Saved")).toBe(true);

  // "New todo…" from the main menu → create mode → Save adds.
  menuItem(r.slots, "New todo…").submit();
  await until(() => panel(r.slots, "todos:editor") !== undefined);
  const composer = panel<TitleFormView>(r.slots, "todos:editor")?.model as TitleFormView;
  expect(composer.getDraft().title).toBe("");
  composer.editField("title", "Water plants");
  composer.save.submit();
  await until(() => titles(r).includes("Water plants"));

  // Delete.
  list.select([byTitle(list, "Water plants").id]);
  selectionAction(list, "Delete").submit();
  await until(() => !titles(r).includes("Water plants"));

  // Clear completed: asks, then removes what was done when asked, and notifies.
  toolbarAction(list, "Clear completed").submit();
  await until(() => dialog(r.slots, "todos:clear-completed") !== undefined);
  const confirm = dialog<ConfirmView>(r.slots, "todos:clear-completed")?.model as ConfirmView;
  expect(confirm.getQuestion().text).toBe("Delete 2 completed todos?");
  confirm.confirm.submit();
  await until(() => dialog(r.slots, "todos:clear-completed") === undefined);
  expect(titles(r)).toEqual(["Write the report", "Call mum"]);
  expect(toasts(r.slots).some((t) => t.message === "Cleared 2 completed todos")).toBe(true);
}

export const contactList = (r: Running) => {
  const p = panel<ContactListView>(r.slots, "contacts:list");
  if (!p) throw new Error("no contacts:list panel");
  return p.model;
};

export async function contactsScenario(r: Running): Promise<void> {
  await until(() => contactList(r).getContacts().length === 3);
  const list = contactList(r);
  expect(list.getContacts().map((c) => c.name)).toEqual([
    "Ada Lovelace",
    "Alan Turing",
    "Grace Hopper",
  ]);
  expect(panel(r.slots, "contacts:details")).toBeUndefined();
  expect(menuItem(r.slots, "Edit contact").getState().enabled).toBe(false);

  list.select("c2");
  expect(panel(r.slots, "contacts:details")).toBeDefined();
  expect(menuItem(r.slots, "Edit contact").getState().enabled).toBe(true);

  // Edit (selection action) → editor seeded from the stored contact.
  const edit = list.getSelectionActions().find((a) => a.action.getState().label === "Edit")?.action;
  edit?.submit();
  await until(() => panel(r.slots, "contacts:editor") !== undefined);
  const editor = panel<ContactEditorView>(r.slots, "contacts:editor")?.model as ContactEditorView;
  expect(editor.getDraft().name).toBe("Alan Turing");

  // An empty name fails: error on the form + error notification; the editor stays.
  editor.editField("name", "  ");
  editor.save.submit();
  await until(() => editor.getStatus().errors.form !== undefined);
  expect(editor.getStatus().errors.form).toBe("Name is required");
  expect(toasts(r.slots).some((t) => t.tone === "error")).toBe(true);
  expect(panel(r.slots, "contacts:editor")).toBeDefined();

  // Fix and save: closes, notifies "Saved", details follow.
  editor.editField("name", "Alan M. Turing");
  editor.save.submit();
  await until(() => panel(r.slots, "contacts:editor") === undefined);
  expect(toasts(r.slots).some((t) => t.message === "Saved")).toBe(true);
  expect(list.getContacts().find((c) => c.id === "c2")?.name).toBe("Alan M. Turing");

  // Cancel withdraws the editor.
  menuItem(r.slots, "Edit contact").submit();
  await until(() => panel(r.slots, "contacts:editor") !== undefined);
  const reopened = panel<ContactEditorView>(r.slots, "contacts:editor")?.model as ContactEditorView;
  reopened.cancel.submit();
  await until(() => panel(r.slots, "contacts:editor") === undefined);
}

/** Interaction (1): "New todo for this contact" — Contacts is not edited to allow it. */
export async function newTodoForContactScenario(r: Running): Promise<void> {
  await until(() => contactList(r).getContacts().length === 3);
  const list = contactList(r);
  const link = () =>
    list
      .getSelectionActions()
      .find((a) => a.action.getState().label === "New todo for this contact")?.action;
  expect(link()?.getState().enabled).toBe(false);
  list.select("c3");
  expect(link()?.getState().enabled).toBe(true);
  link()?.submit();
  await until(() => panel(r.slots, "todos:editor") !== undefined);
  const composer = panel<TitleFormView>(r.slots, "todos:editor")?.model as TitleFormView;
  expect(composer.getDraft().title).toBe("Grace Hopper");
  composer.save.submit();
  await until(() => titles(r).includes("Grace Hopper"));
}

/** Interaction (2): the header count follows the collection, with no command. */
export async function headerCountScenario(r: Running, header: () => string[]): Promise<void> {
  await until(() => header().includes("2 open todos"));
  const list = todoList(r);
  const milk = list.getItems().find((t) => t.title === "Buy milk")?.id as string;
  list.select([milk]);
  list.toggle.submit();
  await until(() => header().includes("1 open todos"));
  list.setNewTitle("Another");
  toolbarAction(list, "Add").submit();
  await until(() => header().includes("2 open todos"));
}
