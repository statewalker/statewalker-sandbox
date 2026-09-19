import type { ContactEditorView } from "@p5/contacts/api";
import { contactsEditOpen } from "@p5/contacts/api";
import { MemContactsApi } from "@p5/contacts.core";
import { call } from "@p5/kernel";
import type { TitleFormView } from "@p5/todos/api";
import { MemTodoApi } from "@p5/todos.core";
import { afterEach, describe, expect, it } from "vitest";
import {
  errorLogs,
  panel,
  type Running,
  start,
  toasts,
  until,
  workbenchHeadless,
} from "../support/harness.js";
import { contactList, selectionAction, titles, todoList } from "../support/scenarios.js";

/**
 * D4 — "the narrowest open scope takes the outcome" (K §4.5), pinned for cancel-mid-save and
 * replace-mid-save, success and failure (the P2 readability review found P0's asymmetry — a stale
 * success notified, a stale failure swallowed — and the machines' silent drop, both untested).
 *
 * - session open: the form gets the error (or closes) AND a notification is shown;
 * - session closed (cancel / replacement), bundle active: only a notification — for success and
 *   failure alike; the replacing session is untouched;
 * - bundle deactivated: nothing is written (races.test.ts, dispose.test.ts).
 */
const DELAY = 30;
const messages = (r: Running) => toasts(r.slots).map((t) => t.message);

describe("outcome of an in-flight Save after its session closed (D4)", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  async function openContact(running: Running, id: string): Promise<ContactEditorView> {
    await until(() => contactList(running).getContacts().length === 3);
    const before = panel(running.slots, "contacts:editor")?.model;
    contactList(running).select(id);
    contactList(running).getSelectionActions()[0].action.submit();
    await until(() => {
      const now = panel(running.slots, "contacts:editor")?.model;
      return now !== undefined && now !== before;
    });
    return panel<ContactEditorView>(running.slots, "contacts:editor")?.model as ContactEditorView;
  }
  const updates = (api: MemContactsApi) => api.calls.filter((c) => c.method === "update");

  it("cancel mid-save, success: Cancel is drained after the Save; it lands and is notified", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const editor = await openContact(r, "c1");
    editor.editField("name", "Ada K. Lovelace");
    editor.save.submit();
    editor.cancel.submit(); // while the Save is running
    await until(() => panel(r?.slots as never, "contacts:editor") === undefined);
    expect(messages(r)).toEqual(["Saved Ada K. Lovelace"]);
    expect(updates(api)).toHaveLength(1);
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("cancel mid-save, failure: the failure is notified, then the editor closes", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const editor = await openContact(r, "c1");
    editor.editField("name", "   "); // the api rejects an empty name
    editor.save.submit();
    editor.cancel.submit();
    await until(() => panel(r?.slots as never, "contacts:editor") === undefined);
    expect(messages(r)).toEqual(["Could not save Ada Lovelace: Name is required"]);
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("replace mid-save, success: notified; the replacing editor is untouched", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const first = await openContact(r, "c1");
    first.editField("name", "Ada K. Lovelace");
    first.save.submit();
    await until(() => updates(api).length === 1); // in flight
    const second = await openContact(r, "c2"); // replaces the first session
    second.editField("phone", "typing in the second");
    await until(() => messages(r as Running).length > 0);
    expect(messages(r)).toEqual(["Saved Ada K. Lovelace"]);
    const now = panel<ContactEditorView>(r.slots, "contacts:editor")?.model;
    expect(now).toBe(second); // not closed by the first session's success
    expect(second.getStatus()).toMatchObject({ dirty: true, errors: {} });
    expect(second.getDraft().phone).toBe("typing in the second");
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("replace mid-save, failure: notified (never swallowed); the replacing editor is untouched", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const first = await openContact(r, "c1");
    first.editField("name", "   ");
    first.save.submit();
    await until(() => updates(api).length === 1);
    const second = await openContact(r, "c2");
    await until(() => messages(r as Running).length > 0);
    expect(messages(r)).toEqual(["Could not save Ada Lovelace: Name is required"]);
    expect(panel(r.slots, "contacts:editor")?.model).toBe(second);
    expect(second.getStatus().errors).toEqual({}); // the failure did not land on the wrong form
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("a record captured in s1 and drained after s1 closed is still committed and reported", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const first = await openContact(r, "c1");
    first.editField("name", "Ada K. Lovelace");
    first.save.submit(); // the record exists; the drain runs a microtask later …
    void call(r.slots, contactsEditOpen, { id: "c2" }); // … after this replaces s1, same tick
    await until(() => messages(r as Running).length > 0);
    expect(updates(api).map((c) => c.args)).toEqual([
      ["c1", { name: "Ada K. Lovelace", email: "ada@example.org", phone: "+44 20 0001" }],
    ]);
    expect(messages(r)).toEqual(["Saved Ada K. Lovelace"]);
    expect(panel(r.slots, "contacts:editor")?.title).toBe("Edit Alan Turing");
  });

  it("todos.edit follows the same rule: replace mid-save, failure is notified", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    list.select(["t1"]);
    selectionAction(list, "Edit").submit();
    await until(() => panel(r?.slots as never, "todos:editor") !== undefined);
    const first = panel<TitleFormView>(r.slots, "todos:editor")?.model as TitleFormView;
    api.fail("update", "disk full");
    first.editField("title", "Buy oat milk");
    first.save.submit();
    list.select(["t2"]);
    selectionAction(list, "Edit").submit(); // replaces the editor while the save runs
    await until(() => messages(r as Running).length > 0);
    expect(messages(r)).toEqual(['Could not save "Buy oat milk": disk full']);
    const second = panel<TitleFormView>(r.slots, "todos:editor")?.model as TitleFormView;
    expect(second).not.toBe(first);
    expect(second.getStatus().errors).toEqual({});
  });
});
