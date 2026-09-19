import type { ContactEditorView } from "@p5/contacts/api";
import { MemContactsApi } from "@p5/contacts.core";
import { dialogsSlot } from "@p5/shell/api";
import type { ConfirmView, TodoListView } from "@p5/todos/api";
import { callsSlot } from "@p5/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorLogs, panel, start, toasts, until, workbenchHeadless } from "../support/harness.js";
import { contactList, titles, todoList, toolbarAction } from "../support/scenarios.js";

describe("dispose: after the application's cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("every slot is empty and unobserved (command handlers and in-flight calls included)", async () => {
    const r = await start(workbenchHeadless);
    await until(() => titles(r).length === 3);
    // Exercise the app so sessions, dialogs and notifications exist.
    contactList(r).select("c1");
    todoList(r).setNewTitle("x");
    toolbarAction(todoList(r), "Add").submit();
    await until(() => toasts(r.slots).length === 0 && titles(r).includes("x"));
    toolbarAction(todoList(r), "Clear completed").submit();
    await until(() =>
      r.slots.usage().some((u) => u.key === "shell:dialogs" && u.contributions > 0),
    );
    expect(r.slots.usage().filter((u) => u.command && u.contributions > 0).length).toBeGreaterThan(
      5,
    );

    await r.stop();
    const leftovers = r.slots.usage().filter((u) => u.contributions > 0 || u.observers > 0);
    expect(leftovers).toEqual([]);
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("no model notifies after cleanup, and view-side mutators are no-ops", async () => {
    const r = await start(workbenchHeadless);
    await until(() => titles(r).length === 3);
    const list = panel<TodoListView>(r.slots, "todos:list")?.model as TodoListView;
    let calls = 0;
    list.onNewTitleUpdate(() => calls++);
    list.onSelectionUpdate(() => calls++);
    const add = toolbarAction(list, "Add");
    calls = 0;
    await r.stop();
    list.setNewTitle("after");
    list.select(["t1"]);
    add.submit();
    expect(calls).toBe(0);
    expect(list.getNewTitle()).toBe("");
  });

  it("no timer fires after cleanup (notification timeouts are cleared)", async () => {
    const r = await start(workbenchHeadless, { config: { "shell:notification-timeout-ms": 4000 } });
    await until(() => titles(r).length === 3);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    toolbarAction(todoList(r), "Clear completed").submit();
    await vi.advanceTimersByTimeAsync(10);
    const confirm = r.slots.getSnapshot(dialogsSlot).get("todos:clear-completed")
      ?.model as ConfirmView;
    confirm.confirm.submit();
    await vi.advanceTimersByTimeAsync(10);
    expect(toasts(r.slots).map((t) => t.message)).toEqual(["Cleared 1 completed todo"]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await r.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("nothing is written after an await that resolves late", async () => {
    const api = new MemContactsApi(undefined, 40);
    const r = await start(workbenchHeadless, { services: { "contacts:api": api } });
    await until(() => contactList(r).getContacts().length === 3);
    contactList(r).select("c1");
    contactList(r).getSelectionActions()[0].action.submit();
    await until(() => panel(r.slots, "contacts:editor") !== undefined);
    const editor = panel<ContactEditorView>(r.slots, "contacts:editor")?.model as ContactEditorView;
    editor.editField("name", "Ada K. Lovelace");
    editor.save.submit();
    await until(() => editor.save.getState().running);
    // P1: the in-flight write is visible as state — a pending call in `sys:calls`.
    expect([...r.slots.getSnapshot(callsSlot).values()].map((c) => c.key)).toEqual([
      "contacts:update",
    ]);
    await r.stop(); // while the save is in flight: its owner's handler leaves ⇒ the call is abandoned
    const before = r.slots.usage().filter((u) => u.contributions > 0);
    await new Promise((resolve) => setTimeout(resolve, 80)); // the save lands now
    expect(r.slots.usage().filter((u) => u.contributions > 0)).toEqual(before);
    expect(before).toEqual([]);
    expect(editor.save.getState().running).toBe(true); // the disposed model kept its last value
    expect(errorLogs(r.logs)).toEqual([]);
  });
});
