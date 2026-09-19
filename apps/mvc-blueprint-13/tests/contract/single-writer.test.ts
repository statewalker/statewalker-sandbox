import type {
  ContactDetailsView,
  ContactEditorView,
  ContactListView,
  ContactSelectionView,
  ContactsCollectionView,
} from "@p5/contacts/api";
import type { HelloView } from "@p5/hello/api";
import type { HeaderItemView, NotificationView } from "@p5/shell/api";
import type {
  ConfirmView,
  TitleFormView,
  TodoListView,
  TodosCollectionView,
  TodosSelectionView,
} from "@p5/todos/api";
import type { ActionControl, ActionView } from "@p5/kernel";
import { createAction } from "@p5/kit-model";
import { describe, expect, it } from "vitest";
import { createContactEditorModel } from "../../packages/bundles/contacts.edit/editor.model.js";
import { createContactListModel } from "../../packages/bundles/contacts.list/list.model.js";
import { createCollectionModel } from "../../packages/bundles/todos.core/collection.model.js";
import { createEditorModel } from "../../packages/bundles/todos.edit/editor.model.js";
import { createListModel } from "../../packages/bundles/todos.list/list.model.js";

/**
 * Single writer (ARCHITECTURE §7.2), checked two ways.
 * TYPE LEVEL (tsc): no view facet can name a presentation/action-description writer; no control
 * facet can name a field-level form writer. A violation fails `pnpm typecheck`.
 */
type PresentationWriter = `publish${string}` | `report${string}` | "reset" | "update" | "markSaved";
type FieldWriter = "editField" | "select" | "setNewTitle" | "submit" | "dismiss";
type Clean<T> = [T] extends [never] ? true : false;
type NoPresentationWriter<V> = Clean<Extract<keyof V, PresentationWriter>>;
type NoFieldWriter<C> = Clean<Extract<keyof C, FieldWriter>>;

const views: [
  NoPresentationWriter<ActionView>,
  NoPresentationWriter<TodoListView>,
  NoPresentationWriter<TitleFormView>,
  NoPresentationWriter<ConfirmView>,
  NoPresentationWriter<TodosCollectionView>,
  NoPresentationWriter<TodosSelectionView>,
  NoPresentationWriter<ContactListView>,
  NoPresentationWriter<ContactDetailsView>,
  NoPresentationWriter<ContactEditorView>,
  NoPresentationWriter<ContactSelectionView>,
  NoPresentationWriter<ContactsCollectionView>,
  NoPresentationWriter<HeaderItemView>,
  NoPresentationWriter<NotificationView>,
  NoPresentationWriter<HelloView>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true];

const controls: [
  NoFieldWriter<ActionControl>,
  NoFieldWriter<ReturnType<typeof createListModel>["control"]>,
  NoFieldWriter<ReturnType<typeof createEditorModel>["control"]>,
  NoFieldWriter<ReturnType<typeof createContactEditorModel>["control"]>,
  NoFieldWriter<ReturnType<typeof createCollectionModel>["control"]>,
  NoFieldWriter<ReturnType<typeof createContactListModel>["control"]>,
] = [true, true, true, true, true, true];

// Negative control: the checks can fail.
// @ts-expect-error — a view with a presentation writer is rejected
const badView: NoPresentationWriter<{ publishItems(): void }> = true;
// @ts-expect-error — a control with a field writer is rejected
const badControl: NoFieldWriter<{ editField(): void }> = true;

const PRESENTATION_WRITER = /^(publish|report)|^(reset|update|markSaved)$/;
const FIELD_WRITER = /^(editField|select|setNewTitle|submit|dismiss)$/;

/** RUNTIME: facets are frozen (no holder can swap a member), and hold no writer of the other side. */
function facetNames(facet: object): string[] {
  expect(Object.isFrozen(facet)).toBe(true);
  return Object.keys(facet);
}

describe("single writer", () => {
  it("type-level checks compiled (see tsc)", () => {
    expect([...views, ...controls].every((ok) => ok === true)).toBe(true);
    expect(badView && badControl).toBe(true);
  });

  it("runtime: every view facet is frozen and exposes no presentation writer", () => {
    const list = createListModel();
    const editor = createEditorModel({ title: "x" });
    const contact = createContactEditorModel({ name: "a", email: "b", phone: "c" });
    const collection = createCollectionModel();
    const contacts = createContactListModel();
    const action = createAction({ label: "Go" });
    for (const facet of [
      list.view,
      list.selection,
      editor.view,
      contact.view,
      collection.view,
      contacts.view,
      contacts.selection,
      action.view,
    ]) {
      for (const name of facetNames(facet)) expect(name).not.toMatch(PRESENTATION_WRITER);
    }
  });

  it("runtime: every control facet is frozen and exposes no field-level form writer", () => {
    for (const facet of [
      createListModel().control,
      createEditorModel({ title: "x" }).control,
      createContactEditorModel({ name: "a", email: "b", phone: "c" }).control,
      createCollectionModel().control,
      createContactListModel().control,
      createAction({ label: "Go" }).control,
    ]) {
      for (const name of facetNames(facet)) expect(name).not.toMatch(FIELD_WRITER);
    }
  });

  it("negative control: the runtime patterns match the writers they police", () => {
    expect("publishItems").toMatch(PRESENTATION_WRITER);
    expect("reportErrors").toMatch(PRESENTATION_WRITER);
    expect("getItems").not.toMatch(PRESENTATION_WRITER);
    expect("editField").toMatch(FIELD_WRITER);
    expect("getSubmits").not.toMatch(FIELD_WRITER);
  });
});
