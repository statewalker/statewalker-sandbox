import { seedContacts } from "@b/contacts.core";
import type { HelloView } from "@b/hello/api";
import { seedTodos } from "@b/todos.core";
import { createAction } from "@kit/model";
import { createContactEditorModel } from "../../src/bundles/contacts.edit/editor.model.js";
import { createContactListModel } from "../../src/bundles/contacts.list/list.model.js";
import { createConfirmModel } from "../../src/bundles/todos.clear-completed/confirm.model.js";
import { createEditorModel } from "../../src/bundles/todos.edit/editor.model.js";
import { createListModel } from "../../src/bundles/todos.list/list.model.js";
import { createRenameModel } from "../../src/bundles/todos.rename/rename.model.js";

/**
 * One real view facet per view kind, built with P0's own model factories (the facets a controller
 * publishes). `hello` builds its model inside its activator, so it gets a plain equivalent.
 */
export function viewModels(): Record<string, unknown> {
  const list = createListModel();
  list.control.publishItems(seedTodos);
  const contacts = createContactListModel();
  contacts.control.publishContacts(seedContacts);
  contacts.view.select("c1");
  const increment = createAction({ label: "Say hello" });
  const hello: HelloView = Object.freeze({
    getCount: () => 0,
    onCountUpdate: (l: () => void) => {
      l();
      return () => {};
    },
    increment: increment.view,
  });
  return {
    "todos:list": list.view,
    "todos:editor": createEditorModel({ title: "x" }).view,
    "todos:rename": createRenameModel("x").view,
    "todos:clear-completed": createConfirmModel("Delete?", "Clear").view,
    "contacts:list": contacts.view,
    "contacts:details": contacts.selection,
    "contacts:editor": createContactEditorModel({ name: "a", email: "b", phone: "c" }).view,
    "hello:panel": hello,
  };
}

/** The view-side writers of P0's models (tests/contract/single-writer.test.ts's FIELD_WRITER). */
export const VIEW_WRITERS = /^(editField|select|setNewTitle|submit|dismiss)$/;
