/** §14.3 Contacts behaviour and §14.4 interactions (1)–(3), headless. */
import { afterEach, describe, expect, it } from "vitest";
import {
  type ContactDetailsProps,
  type ContactEditorProps,
  type ContactsListProps,
  contactEditorIntents,
  contactsListIntents,
} from "../../src/bundles/contacts/api/index.ts";
import {
  type TodoEditorProps,
  todoEditorIntents,
  type TodosListProps,
} from "../../src/bundles/todos/api/index.ts";
import {
  contactsFeature,
  shellFeature,
  todosContactsFeature,
  todosFeature,
} from "../../src/features.ts";
import { type Harness, start, until } from "../support/harness.ts";
import { user } from "../support/user.ts";

let h: Harness;
afterEach(async () => {
  expect(h.errors()).toEqual([]);
  await h.stop();
});

const boot = async (features = [shellFeature, contactsFeature]) => {
  h = await start(features);
  const u = user(h.store);
  await until(() => !!u.panel("contacts.list"));
  return {
    u,
    list: () => u.panel<ContactsListProps>("contacts.list")?.props as ContactsListProps,
    details: () => u.panel<ContactDetailsProps>("contacts.details")?.props,
    editor: () => u.panel<ContactEditorProps>("contacts.edit")?.props,
  };
};

describe("contacts", () => {
  it("lists names; selecting publishes the details panel", async () => {
    const { u, list, details } = await boot();
    expect(list().rows.map((r) => r.name)).toEqual(["Ada Lovelace", "Alan Turing", "Grace Hopper"]);
    expect(details()).toBeUndefined();
    h.dispatch(contactsListIntents.select({ id: "c2" }));
    expect(details()?.contact.name).toBe("Alan Turing");
    expect(u.panelIds()).toEqual(["contacts.list", "contacts.details"]);
  });

  it("Edit opens the editor seeded from the store; Save closes and notifies Saved", async () => {
    const { u, list, editor } = await boot();
    expect(u.action(list().selectionActions, "Edit")?.enabled).toBe(false);
    h.dispatch(contactsListIntents.select({ id: "c1" }));
    u.press(u.action(list().selectionActions, "Edit"));
    expect(editor()?.draft).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.org",
      phone: "+44 20 0000 0001",
    });
    h.dispatch(contactEditorIntents.field({ field: "email", value: "ada@lovelace.org" }));
    u.press(editor()?.save);
    await until(() => !editor());
    expect(u.toasts()).toEqual(["success:Saved"]);
    u.press(u.action(list().selectionActions, "Edit"));
    expect(editor()?.draft.email).toBe("ada@lovelace.org");
  });

  it("an empty name fails: error on the form, an error toast, the editor stays", async () => {
    const { u, list, editor } = await boot();
    h.dispatch(contactsListIntents.select({ id: "c3" }));
    u.press(u.action(list().selectionActions, "Edit"));
    h.dispatch(contactEditorIntents.field({ field: "name", value: "  " }));
    u.press(editor()?.save);
    await until(() => !!editor()?.error);
    expect(editor()?.error).toBe("Name is required");
    expect(u.toasts()).toEqual(["error:Save failed: Name is required"]);
    u.press(editor()?.cancel);
    expect(editor()).toBeUndefined();
  });

  it("menu: Edit contact is enabled only while a contact is selected", async () => {
    const { u, editor } = await boot();
    expect(u.menuItem("Edit contact")?.enabled).toBe(false);
    h.dispatch(contactsListIntents.select({ id: "c1" }));
    expect(u.press(u.menuItem("Edit contact"))).toBe(true);
    expect(editor()?.draft.name).toBe("Ada Lovelace");
  });
});

describe("cross-app interactions", () => {
  const all = [shellFeature, todosFeature, contactsFeature, todosContactsFeature];

  it("(1) New todo for this contact: follows the selection; composes a todo with the name", async () => {
    const { u, list } = await boot(all);
    const newTodo = () => u.action(list().selectionActions, "New todo for this contact");
    expect(list().selectionActions.map((a) => a.label)).toEqual([
      "Edit",
      "New todo for this contact",
    ]);
    expect(newTodo()?.enabled).toBe(false);
    h.dispatch(contactsListIntents.select({ id: "c2" }));
    u.press(newTodo());
    const editor = () => u.panel<TodoEditorProps>("todos.edit")?.props;
    expect(editor()).toMatchObject({ mode: "create", title: "Alan Turing" });
    h.dispatch(todoEditorIntents.title({ title: "Call Alan Turing" }));
    u.press(editor()?.save);
    await until(() => (u.panel<TodosListProps>("todos.list")?.props.rows.length ?? 0) === 4);
    expect(u.header()).toEqual(["3 open todos"]);
  });

  it("(1) reads the selection at commit time: select-then-press in one tick uses the new selection", async () => {
    const { u, list } = await boot(all);
    h.dispatch(contactsListIntents.select({ id: "c1" }));
    const pressed = u.action(list().selectionActions, "New todo for this contact"); // rendered for Ada
    h.dispatch(contactsListIntents.select({ id: "c3" })); // the user changes the selection first
    u.press(pressed);
    expect(u.panel<TodoEditorProps>("todos.edit")?.props.title).toBe("Grace Hopper");
  });

  it("(2) header count follows toggles without any command", async () => {
    const { u } = await boot(all);
    await until(() => u.header().length === 1);
    expect(u.header()).toEqual(["2 open todos"]);
  });

  it("(3) one main menu with both groups", async () => {
    const { u } = await boot(all);
    const groups = [...new Set(u.menu().map((m) => m.groupLabel))].sort();
    expect(groups).toEqual(["Contacts", "Todos"]);
  });
});
