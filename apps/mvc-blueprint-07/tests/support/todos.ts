import type { ContactEditorView, ContactsListView } from "../../src/bundles/contacts/api/index.js";
import type {
  ClearCompletedView,
  TodoEditorView,
  TodosListView,
} from "../../src/bundles/todos/api/index.js";
import type { IntentRecord } from "../../src/kernel/log.js";
import type { ActionView } from "../../src/kernel/models.js";
import type { Probe } from "./headless.js";

export const list = (app: Probe) => app.panel<TodosListView>("todos:list") as TodosListView;
export const titles = (app: Probe) =>
  list(app)
    .getItems()
    .map((t) => t.title);
export const selectionAction = (app: Probe, label: string): ActionView => {
  const found = list(app)
    .getSelectionActions()
    .find((e) => e.action.getState().label === label);
  if (!found) throw new Error(`no selection action ${label}`);
  return found.action;
};
export const toolbarAction = (app: Probe, label: string): ActionView => {
  const found = list(app)
    .getToolbar()
    .find((e) => e.action.getState().label === label);
  if (!found) throw new Error(`no toolbar action ${label}`);
  return found.action;
};
export const editor = (app: Probe, id: string) => app.panel<TodoEditorView>(`todos:editor:${id}`);
export const confirmDialog = (app: Probe) =>
  app.dialog<ClearCompletedView>("todos:clear-completed");
export const contactList = (app: Probe) =>
  app.panel<ContactsListView>("contacts:list") as ContactsListView;
export const contactAction = (app: Probe, label: string): ActionView => {
  const found = contactList(app)
    .getActions()
    .find((e) => e.action.getState().label === label);
  if (!found) throw new Error(`no contact action ${label}`);
  return found.action;
};
export const contactEditor = (app: Probe, id: string) =>
  app.panel<ContactEditorView>(`contacts:editor:${id}`);
export const recordsOf = (app: Probe, type: string) =>
  app.log.records().filter((r): r is IntentRecord => r.kind === "intent" && r.type === type);

/** Opens the editor for a todo the way a user does: select it, then the Edit selection action. */
export function openTodoEditor(app: Probe, id: string): TodoEditorView {
  list(app).select(id, false);
  selectionAction(app, "Edit").submit();
  const e = editor(app, id);
  if (!e) throw new Error(`editor for ${id} not published`);
  return e;
}
