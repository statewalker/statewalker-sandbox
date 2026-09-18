/**
 * The §14 scenario, driven headlessly as a view would drive it. Shared by the workbench, standalone
 * and removal suites: each exported function is one behaviour and asserts it.
 */
import { expect } from "vitest";
import type {
  ContactEditorState,
  ContactsListState,
  DetailsState,
} from "../../src/bundles/contacts/api/index.js";
import type {
  ClearCompletedState,
  EditorState,
  ListState,
} from "../../src/bundles/todos/api/index.js";
import { findAction, type Harness, waitFor } from "../support/headless.js";

export const list = (h: Harness) => h.view<ListState>("todos:list");
export const titles = (h: Harness) => list(h)?.todos.map((t) => t.title) ?? [];
export const todoId = (h: Harness, title: string) =>
  list(h)?.todos.find((t) => t.title === title)?.id ?? "";

export async function todosBasics(h: Harness): Promise<void> {
  await waitFor(() => titles(h).length === 3);
  expect(titles(h)).toEqual(["Buy milk", "Write report", "Call plumber"]);

  // Add through the new-title input.
  h.send("todos:list", { type: "new-title", value: "Call mum" });
  h.dispatch(findAction(list(h)?.toolbar, "Add"));
  await waitFor(() => titles(h).includes("Call mum"));
  expect(list(h)?.newTitle).toBe("");

  // Toggle through the checkbox.
  h.send("todos:list", { type: "toggle-one", id: todoId(h, "Buy milk") });
  await waitFor(() => list(h)?.todos.find((t) => t.title === "Buy milk")?.done === true);

  // Select + Delete.
  h.send("todos:list", { type: "select", id: todoId(h, "Call mum"), additive: false });
  h.dispatch(findAction(list(h)?.selectionActions, "Delete"));
  await waitFor(() => !titles(h).includes("Call mum"));

  // Edit + Save.
  h.send("todos:list", { type: "select", id: todoId(h, "Write report"), additive: false });
  h.dispatch(findAction(list(h)?.selectionActions, "Edit"));
  expect(h.panelIds()).toContain("todos:editor");
  h.send("todos:editor", { type: "edit", title: "Write the report" });
  h.dispatch(h.view<EditorState>("todos:editor")?.save);
  await waitFor(() => !h.panelIds().includes("todos:editor"));
  expect(titles(h)).toContain("Write the report");
  expect(h.notes().map((n) => n.message)).toContain("Saved");

  // Clear completed: asks, then removes what was done WHEN ASKED.
  h.dispatch(findAction(list(h)?.toolbar, "Clear completed"));
  expect(h.dialogIds()).toEqual(["todos:clear-completed"]);
  expect(h.view<ClearCompletedState>("todos:clear-completed")?.count).toBe(2);
  h.dispatch(h.view<ClearCompletedState>("todos:clear-completed")?.confirm);
  await waitFor(() => h.dialogIds().length === 0);
  expect(titles(h)).toEqual(["Write the report"]);
  expect(h.notes().map((n) => n.message)).toContain("Cleared 2 completed todos");
}

export async function todosEditorFailureAndCancel(h: Harness): Promise<void> {
  await waitFor(() => titles(h).length === 3);
  h.dispatch(h.menuAction("New todo…"));
  expect(h.view<EditorState>("todos:editor")?.mode).toBe("create");
  h.dispatch(h.view<EditorState>("todos:editor")?.save); // empty title
  expect(h.view<EditorState>("todos:editor")?.error).toBe("Title is required");
  expect(h.panelIds()).toContain("todos:editor");
  h.dispatch(h.view<EditorState>("todos:editor")?.cancel);
  expect(h.panelIds()).not.toContain("todos:editor");
}

export const contactsList = (h: Harness) => h.view<ContactsListState>("contacts:list");
export const contactId = (h: Harness, name: string) =>
  contactsList(h)?.contacts.find((c) => c.name === name)?.id ?? "";

export async function contactsBasics(h: Harness): Promise<void> {
  await waitFor(() => (contactsList(h)?.contacts.length ?? 0) === 3);
  expect(h.menuAction("Edit contact")?.enabled).toBe(false);
  h.send("contacts:list", { type: "select", id: contactId(h, "Alan Turing") });
  expect(h.view<DetailsState>("contacts:details")?.contact.name).toBe("Alan Turing");
  expect(h.menuAction("Edit contact")?.enabled).toBe(true);

  // Edit → failing save (empty name) keeps the form open with the error and notifies.
  h.dispatch(findAction(h.view<DetailsState>("contacts:details")?.actions, "Edit"));
  expect(h.view<ContactEditorState>("contacts:editor")?.draft.name).toBe("Alan Turing");
  h.send("contacts:editor", { type: "edit", field: "name", value: "  " });
  h.dispatch(h.view<ContactEditorState>("contacts:editor")?.save);
  await waitFor(() => h.view<ContactEditorState>("contacts:editor")?.error !== undefined);
  expect(h.view<ContactEditorState>("contacts:editor")?.error).toBe("Name is required");
  expect(h.notes().some((n) => n.tone === "error")).toBe(true);

  // Fix it and save: closes, notifies Saved, details show the new data.
  h.send("contacts:editor", { type: "edit", field: "name", value: "Alan M. Turing" });
  h.send("contacts:editor", { type: "edit", field: "email", value: "turing@example.org" });
  h.dispatch(h.view<ContactEditorState>("contacts:editor")?.save);
  await waitFor(() => !h.panelIds().includes("contacts:editor"));
  expect(h.notes().map((n) => n.message)).toContain("Saved");
  expect(h.view<DetailsState>("contacts:details")?.contact).toMatchObject({
    name: "Alan M. Turing",
    email: "turing@example.org",
  });

  // Cancel withdraws the editor.
  h.dispatch(h.menuAction("Edit contact"));
  expect(h.panelIds()).toContain("contacts:editor");
  h.dispatch(h.view<ContactEditorState>("contacts:editor")?.cancel);
  expect(h.panelIds()).not.toContain("contacts:editor");
}

/** Interaction (1): "New todo for this contact", commit-time selection. */
export async function newTodoForContact(h: Harness): Promise<void> {
  await waitFor(() => (contactsList(h)?.contacts.length ?? 0) === 3 && titles(h).length > 0);
  h.send("contacts:list", { type: "select", id: contactId(h, "Grace Hopper") });
  const action = findAction(
    h.view<DetailsState>("contacts:details")?.actions,
    "New todo for this contact",
  );
  expect(action?.enabled).toBe(true);
  h.dispatch(action);
  expect(h.view<EditorState>("todos:editor")).toMatchObject({
    mode: "create",
    title: "Grace Hopper",
  });
  h.dispatch(h.view<EditorState>("todos:editor")?.save);
  await waitFor(() => titles(h).includes("Grace Hopper"));
}

/** Interaction (2): the header count follows the collection with no command. */
export async function headerCount(h: Harness): Promise<void> {
  await waitFor(() => h.headerTexts().includes("2 open todos"));
  h.send("todos:list", { type: "toggle-one", id: todoId(h, "Buy milk") });
  await waitFor(() => h.headerTexts().includes("1 open todos"));
  h.send("todos:list", { type: "new-title", value: "Another" });
  h.dispatch(findAction(list(h)?.toolbar, "Add"));
  await waitFor(() => h.headerTexts().includes("2 open todos"));
}
