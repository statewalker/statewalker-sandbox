import type { ContactEditorView } from "@p5/contacts/api";
import { MemContactsApi } from "@p5/contacts.core";
import type { ConfirmView, TitleFormView } from "@p5/todos/api";
import { MemTodoApi } from "@p5/todos.core";
import { todosClearCompletedAsk } from "@p5/todos/api";
import { call } from "@p5/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  dialog,
  panel,
  type Running,
  start,
  until,
  workbenchHeadless,
} from "../support/harness.js";
import { contactList, titles, todoList, toolbarAction } from "../support/scenarios.js";

const DELAY = 30;

describe("commit time (ARCHITECTURE §10)", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  async function openContactEditor(running: Running, id: string): Promise<ContactEditorView> {
    await until(() => contactList(running).getContacts().length === 3);
    contactList(running).select(id);
    contactList(running).getSelectionActions()[0].action.submit();
    await until(() => panel(running.slots, "contacts:editor") !== undefined);
    return panel<ContactEditorView>(running.slots, "contacts:editor")?.model as ContactEditorView;
  }

  it("Save acts on the form at submit; typing while it runs belongs to the next commit", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const editor = await openContactEditor(r, "c1");
    editor.editField("email", "ada@new.org");
    editor.save.submit();
    editor.editField("email", "ada@typed-after.org"); // same tick, after the submit
    await until(() => editor.save.getState().running);
    editor.editField("phone", "999"); // while the save runs
    await until(() => panel(r?.slots as never, "contacts:editor") === undefined);
    const update = api.calls.find((c) => c.method === "update");
    expect(update?.args[1]).toEqual({ email: "ada@new.org" }); // the commit's changes, nothing typed later
  });

  it("Save is REFUSED while running: visibly (running: true), never silently queued", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const editor = await openContactEditor(r, "c2");
    editor.editField("name", "Alan");
    editor.save.submit();
    await until(() => editor.save.getState().running);
    expect(editor.save.getState()).toMatchObject({ running: true });
    editor.editField("name", "Alan T.");
    editor.save.submit(); // refused: the view shows running
    await until(() => panel(r?.slots as never, "contacts:editor") === undefined);
    expect(api.calls.filter((c) => c.method === "update")).toHaveLength(1);
  });

  it("two submits in one tick are one commit, on the state of the first", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    const editor = await openContactEditor(r, "c3");
    editor.editField("name", "Grace B. Hopper");
    editor.save.submit();
    editor.editField("name", "Grace X");
    editor.save.submit();
    await until(() => panel(r?.slots as never, "contacts:editor") === undefined);
    const updates = api.calls.filter((c) => c.method === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].args[1]).toMatchObject({ name: "Grace B. Hopper" });
  });

  it("Add is QUEUED: submits while it runs are accepted and each honoured with its own title", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    const add = toolbarAction(list, "Add");
    list.setNewTitle("one");
    add.submit();
    await until(() => add.getState().running);
    expect(add.getState().enabled).toBe(true); // still accepting
    list.setNewTitle("two");
    add.submit();
    list.setNewTitle("three");
    add.submit();
    await until(() => titles(r as Running).length === 6);
    expect(titles(r).slice(3)).toEqual(["one", "two", "three"]);
    // The draft typed after the last submit is not cleared by an earlier Add landing.
    expect(list.getNewTitle()).toBe("");
  });

  it("an Add that lands does not clear a title the user typed meanwhile", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    list.setNewTitle("first");
    toolbarAction(list, "Add").submit();
    list.setNewTitle("second, not submitted");
    await until(() => titles(r as Running).includes("first"));
    expect(list.getNewTitle()).toBe("second, not submitted");
  });

  it("Clear completed removes what was done WHEN ASKED, and is refused while its dialog is open", async () => {
    const api = new MemTodoApi(undefined, 0);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    const clear = toolbarAction(list, "Clear completed");
    clear.submit();
    await until(() => dialog(r?.slots as never, "todos:clear-completed") !== undefined);
    expect(clear.getState().running).toBe(true);
    // Tick "Buy milk" done after asking: it is not part of the question.
    list.select(["t1"]);
    list.toggle.submit();
    await until(() => list.getItems().find((t) => t.id === "t1")?.done === true);
    clear.submit(); // refused while the dialog is open
    const confirm = dialog<ConfirmView>(r.slots, "todos:clear-completed")?.model as ConfirmView;
    expect(confirm.getQuestion().text).toBe("Delete 1 completed todo?");
    confirm.confirm.submit();
    await until(() => dialog(r?.slots as never, "todos:clear-completed") === undefined);
    expect(titles(r)).toEqual(["Buy milk", "Write report"]);
    expect(api.calls.filter((c) => c.method === "remove").map((c) => c.args[0])).toEqual(["t3"]);
  });

  it("the contacts link reads the selected contact at commit time", async () => {
    r = await start(workbenchHeadless);
    await until(() => contactList(r as Running).getContacts().length === 3);
    const list = contactList(r);
    list.select("c1");
    const link = list
      .getSelectionActions()
      .find((a) => a.action.getState().label === "New todo for this contact")?.action;
    link?.submit();
    list.select("c2"); // after the commit
    await until(() => panel(r?.slots as never, "todos:editor") !== undefined);
    expect(panel<TitleFormView>(r.slots, "todos:editor")?.model.getDraft().title).toBe(
      "Ada Lovelace",
    );
  });

  it("a failing todo save keeps the form open with the error", async () => {
    const api = new MemTodoApi(undefined, 0);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    list.select(["t2"]);
    list
      .getSelectionActions()
      .find((a) => a.action.getState().label === "Edit")
      ?.action.submit();
    await until(() => panel(r?.slots as never, "todos:editor") !== undefined);
    const editor = panel<TitleFormView>(r.slots, "todos:editor")?.model as TitleFormView;
    api.fail("update", "disk full");
    editor.editField("title", "Write it");
    editor.save.submit();
    await until(() => editor.getStatus().errors.form !== undefined);
    expect(editor.getStatus().errors.form).toBe("Save failed: disk full");
    expect(panel(r.slots, "todos:editor")).toBeDefined();
    expect(editor.getDraft().title).toBe("Write it");
  });

  it("B1: a queue of Adds never delays a Toggle — Add and the selection actions are two lanes", async () => {
    const api = new MemTodoApi(undefined, 100);
    r = await start(workbenchHeadless, { services: { "todos:api": api } });
    await until(() => titles(r as Running).length === 3, 3000);
    const list = todoList(r);
    for (const title of ["a", "b", "c"]) {
      list.setNewTitle(title);
      toolbarAction(list, "Add").submit();
    }
    list.select(["t1"]);
    const t0 = Date.now();
    list.toggle.submit();
    await until(() => !list.toggle.getState().running, 3000);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(150); // one 100 ms write, not behind three
    expect(api.calls.filter((c) => c.method === "add").length).toBeLessThan(3);
  });

  it("C2: todos:clear-completed:ask rejects when the action refuses (busy, or nothing to clear)", async () => {
    r = await start(workbenchHeadless);
    await until(() => titles(r as Running).length === 3);
    const ask = () => call(r?.slots as never, todosClearCompletedAsk, undefined).promise;
    await ask(); // t3 is done: the dialog opens
    await until(() => dialog(r?.slots as never, "todos:clear-completed") !== undefined);
    await expect(ask()).rejects.toThrow("busy");
    const confirm = dialog<ConfirmView>(r.slots, "todos:clear-completed")?.model as ConfirmView;
    confirm.confirm.submit();
    await until(() => titles(r as Running).length === 2);
    await until(() => dialog(r?.slots as never, "todos:clear-completed") === undefined);
    await expect(ask()).rejects.toThrow("nothing to clear");
  });
});
