import type { ContactEditorView } from "@b/contacts/api";
import { MemContactsApi } from "@b/contacts.core";
import type { TitleFormView } from "@b/todos/api";
import { MemTodoApi } from "@b/todos.core";
import { afterEach, describe, expect, it } from "vitest";
import {
  dialog,
  errorLogs,
  mechanism,
  panel,
  type Running,
  start,
  toasts,
  until,
  workbenchHeadless,
} from "../support/harness.js";
import {
  contactList,
  selectionAction,
  titles,
  todoList,
  toolbarAction,
} from "../support/scenarios.js";

/**
 * P3's race suite (ARCHITECTURE §13.5 extended): the same races for every mechanism — this file
 * runs in the node-A, node-B and node-C projects. Flows: Contacts Save (a multi-step commit),
 * Rename, Add (queued), Delete selected, Clear completed (commits.test.ts).
 */
const DELAY = 30;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe(`commit races, mechanism ${mechanism}`, () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  async function contactEditor(running: Running, id: string): Promise<ContactEditorView> {
    await until(() => contactList(running).getContacts().length === 3);
    contactList(running).select(id);
    contactList(running).getSelectionActions()[0].action.submit();
    await until(() => panel(running.slots, "contacts:editor") !== undefined);
    return panel<ContactEditorView>(running.slots, "contacts:editor")?.model as ContactEditorView;
  }
  const editorGone = (running: Running) => () =>
    panel(running.slots, "contacts:editor") === undefined;
  const updates = (api: MemContactsApi) => api.calls.filter((c) => c.method === "update");

  async function renameDialog(running: Running, id: string): Promise<TitleFormView> {
    await until(() => titles(running).length === 3);
    const list = todoList(running);
    list.select([id]);
    selectionAction(list, "Rename…").submit();
    await until(() => dialog(running.slots, "todos:rename") !== undefined);
    return dialog<TitleFormView>(running.slots, "todos:rename")?.model as TitleFormView;
  }

  // ── where `running` becomes visible ────────────────────────────────────────────────────────
  it("running is visible in the submit's own tick (B, C) or a microtask later (A)", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const editor = await contactEditor(r, "c1");
    editor.editField("name", "Ada K.");
    editor.save.submit();
    expect(editor.save.getState().running).toBe(mechanism !== "A");
    await until(editorGone(r));
  });

  // ── change after submit ─────────────────────────────────────────────────────────────────────
  it("Save — the multi-step commit: typing during step 1 and during step 2 is not committed", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, {
      services: { "contacts:api": api },
      config: { "contacts:validate-ms": DELAY },
    });
    const editor = await contactEditor(r, "c1");
    editor.editField("email", "ada@committed.org");
    editor.save.submit();
    editor.editField("email", "same tick"); // after the submit, same tick
    await until(() => editor.save.getState().running);
    editor.editField("email", "during validation"); // step 1 in flight
    expect(updates(api)).toHaveLength(0);
    await until(() => updates(api).length === 1);
    editor.editField("phone", "during update"); // step 2 in flight
    await until(editorGone(r));
    expect(updates(api)[0].args[1]).toEqual({
      name: "Ada Lovelace",
      email: "ada@committed.org",
      phone: "+44 20 0001",
    });
  });

  it("Save — a step-1 failure (validation) reports on the form and a later Save commits anew", async () => {
    const api = new MemContactsApi(undefined, 0);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const editor = await contactEditor(r, "c2");
    editor.editField("email", "not-an-email");
    editor.save.submit();
    await until(() => editor.getStatus().errors.email !== undefined);
    expect(updates(api)).toHaveLength(0);
    expect(editor.save.getState().running).toBe(false); // settled: not stuck
    editor.editField("email", "alan@ok.org");
    editor.save.submit();
    await until(editorGone(r as Running));
    expect(updates(api)[0].args[1]).toMatchObject({ email: "alan@ok.org" });
  });

  it("Rename — typing after the submit and while it runs is not committed", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    const form = await renameDialog(r, "t1");
    form.editField("title", "Buy oat milk");
    form.save.submit();
    form.editField("title", "same tick");
    await until(() => form.save.getState().running);
    form.editField("title", "while running");
    await until(() => dialog(r?.slots as never, "todos:rename") === undefined);
    expect(api.calls.filter((c) => c.method === "update").map((c) => c.args[1])).toEqual([
      { title: "Buy oat milk" },
    ]);
  });

  it("Delete selected — a selection changed after the submit does not retarget it", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    list.select(["t1"]);
    selectionAction(list, "Delete").submit();
    list.select(["t2"]); // same tick
    await until(() => titles(r as Running).length === 2);
    expect(api.calls.filter((c) => c.method === "remove").map((c) => c.args[0])).toEqual(["t1"]);
  });

  it("Add — the title typed after the submit is not the one added", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    list.setNewTitle("committed");
    toolbarAction(list, "Add").submit();
    list.setNewTitle("typed after");
    await until(() => titles(r as Running).length === 4);
    expect(titles(r)[3]).toBe("committed");
    expect(list.getNewTitle()).toBe("typed after");
  });

  // ── two submits in one tick ─────────────────────────────────────────────────────────────────
  it("Rename — two submits in one tick are one commit, on the state of the first", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    const form = await renameDialog(r, "t2");
    form.editField("title", "first");
    form.save.submit();
    form.editField("title", "second");
    form.save.submit();
    await until(() => dialog(r?.slots as never, "todos:rename") === undefined);
    const calls = api.calls.filter((c) => c.method === "update");
    expect(calls.map((c) => c.args[1])).toEqual([{ title: "first" }]);
  });

  it("Delete — two submits in one tick are one commit", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    list.select(["t1"]);
    const del = selectionAction(list, "Delete");
    del.submit();
    list.select(["t2"]);
    del.submit();
    await until(() => titles(r as Running).length === 2);
    await tick();
    expect(api.calls.filter((c) => c.method === "remove").map((c) => c.args[0])).toEqual(["t1"]);
  });

  it("Add — two submits in one tick are two commits (queued), each with its own title", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    const add = toolbarAction(list, "Add");
    list.setNewTitle("one");
    add.submit();
    list.setNewTitle("two");
    add.submit();
    await until(() => titles(r as Running).length === 5);
    expect(titles(r).slice(3)).toEqual(["one", "two"]);
  });

  // ── submit while running ────────────────────────────────────────────────────────────────────
  it("Delete — a submit while running is visibly refused", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    list.select(["t1", "t2"]);
    const del = selectionAction(list, "Delete");
    del.submit();
    await until(() => del.getState().running);
    list.select(["t3"]);
    del.submit(); // refused: the view shows running
    await until(() => titles(r as Running).length === 1);
    await new Promise((resolve) => setTimeout(resolve, DELAY * 2));
    expect(titles(r)).toEqual(["Call plumber"]);
    expect(api.calls.filter((c) => c.method === "remove")).toHaveLength(2);
  });

  it("Rename — a submit while running is visibly refused", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    const form = await renameDialog(r, "t1");
    form.editField("title", "A");
    form.save.submit();
    await until(() => form.save.getState().running);
    form.editField("title", "B");
    form.save.submit();
    await until(() => dialog(r?.slots as never, "todos:rename") === undefined);
    expect(api.calls.filter((c) => c.method === "update")).toHaveLength(1);
  });

  // ── cancel and dispose during a running save ───────────────────────────────────────────────
  it("Cancel during a running Save: the save still lands with its commit, then the editor closes", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const editor = await contactEditor(r, "c3");
    editor.editField("name", "Grace B. Hopper");
    editor.save.submit();
    await until(() => editor.save.getState().running);
    editor.editField("name", "typed then cancelled");
    editor.cancel.submit();
    await until(editorGone(r));
    await until(() => toasts(r?.slots as never).some((t) => t.message === "Saved"));
    expect(updates(api).map((c) => c.args[1])).toEqual([
      { name: "Grace B. Hopper", email: "grace@example.org", phone: "+1 212 0003" },
    ]);
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("Cancel during a FAILING Save: the failure is still reported (notification), the editor closes", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const editor = await contactEditor(r, "c3");
    editor.editField("name", "   ");
    editor.save.submit();
    await until(() => editor.save.getState().running);
    editor.cancel.submit();
    await until(editorGone(r));
    await until(() => toasts(r?.slots as never).some((t) => t.message.startsWith("Save failed")));
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("dispose during a running multi-step Save: step 2 never starts, nothing is written after", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    const running = await start(workbenchHeadless, {
      services: { "contacts:api": api },
      config: { "contacts:validate-ms": DELAY },
    });
    const editor = await contactEditor(running, "c1");
    editor.editField("name", "Ada K.");
    editor.save.submit();
    await until(() => editor.save.getState().running);
    await running.stop(); // during step 1
    await new Promise((resolve) => setTimeout(resolve, DELAY * 3));
    expect(updates(api)).toHaveLength(0);
    expect(running.slots.usage().filter((u) => u.contributions > 0)).toEqual([]);
    expect(errorLogs(running.logs)).toEqual([]);
  });

  it("dispose with Adds queued: the one in flight lands in the api, the queued ones are not sent", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    const running = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(running).length === 3);
    const list = todoList(running);
    const add = toolbarAction(list, "Add");
    for (const t of ["one", "two", "three"]) {
      list.setNewTitle(t);
      add.submit();
    }
    await until(() => api.calls.some((c) => c.method === "add"));
    await running.stop();
    await new Promise((resolve) => setTimeout(resolve, DELAY * 4));
    expect(api.calls.filter((c) => c.method === "add").map((c) => c.args[0])).toEqual(["one"]);
    expect(running.slots.usage().filter((u) => u.contributions > 0)).toEqual([]);
    expect(errorLogs(running.logs)).toEqual([]);
  });
});
