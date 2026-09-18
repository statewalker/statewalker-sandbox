/**
 * §10 commit-time semantics. A commit is a message; the update reads the state as of that message,
 * and the effect it returns carries the snapshot. So "the message carries what was committed".
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type ContactEditorProps,
  type ContactPatch,
  contactEditorIntents,
  contactsListIntents,
} from "../../src/bundles/contacts/api/index.ts";
import { createMemContactApi } from "../../src/bundles/contacts.core/mem-api.ts";
import {
  type TodoEditorProps,
  type TodosListProps,
  todoEditorIntents,
  todosListIntents,
} from "../../src/bundles/todos/api/index.ts";
import { createMemTodoApi } from "../../src/bundles/todos.core/mem-api.ts";
import { contactsFeature, shellFeature, todosFeature } from "../../src/features.ts";
import type { Effect, Msg } from "../../src/kernel/index.ts";
import { gate, type Harness, start, until } from "../support/harness.ts";
import { user } from "../support/user.ts";

let h: Harness;
afterEach(async () => {
  expect(h.errors()).toEqual([]);
  await h.stop();
});

describe("commit time", () => {
  it("contacts Save: edit, save, keep typing while in flight — the api receives the value at save", async () => {
    const g = gate();
    const api = createMemContactApi({ delay: () => g.wait() });
    const received: ContactPatch[] = [];
    const update = api.update;
    api.update = (id, patch) => {
      received.push(patch);
      return update(id, patch);
    };
    h = await start([shellFeature, contactsFeature], { "contacts:api": api });
    g.release();
    const u = user(h.store);
    await until(() => !!u.panel("contacts.list"));
    const editor = () => u.panel<ContactEditorProps>("contacts.edit")?.props;
    h.dispatch(contactsListIntents.select({ id: "c1" }));
    h.dispatch({ type: "contacts.edit/edit-selected" });
    h.dispatch(contactEditorIntents.field({ field: "name", value: "Ada King" }));
    u.press(editor()?.save);
    // two submits in one tick: the second is refused visibly (running), not queued, not lost
    expect(editor()?.save).toMatchObject({ enabled: false, running: true });
    expect(u.press(editor()?.save)).toBe(false);
    h.dispatch(editor()?.save.msg as Msg); // even a forged second dispatch is a no-op
    h.dispatch(contactEditorIntents.field({ field: "name", value: "Ada King-Noel" }));
    expect(editor()?.draft.name).toBe("Ada King-Noel"); // typing continues during the save
    await until(() => g.pending > 0);
    g.openAll();
    await until(() => !editor());
    expect(received).toEqual([
      { name: "Ada King", email: "ada@example.org", phone: "+44 20 0000 0001" },
    ]);
  });

  it("the effect value carries the committed draft (inspectable without running anything)", async () => {
    h = await start([shellFeature, contactsFeature]);
    const u = user(h.store);
    await until(() => !!u.panel("contacts.list"));
    const effects: Effect[] = [];
    // Observe the commit record: wrap the handler's effect type by adding a spy slice update.
    h.store.addSlice({
      id: "spy",
      init: () => 0,
      update: (s, msg) => {
        if (msg.type === "contacts.edit/saved") effects.push(msg as unknown as Effect);
        return s;
      },
    });
    h.dispatch(contactsListIntents.select({ id: "c2" }));
    h.dispatch({ type: "contacts.edit/edit-selected" });
    h.dispatch(contactEditorIntents.field({ field: "phone", value: "555" }));
    u.press(u.panel<ContactEditorProps>("contacts.edit")?.props.save);
    h.dispatch(contactEditorIntents.field({ field: "phone", value: "556" }));
    await until(() => effects.length === 1);
    expect(effects[0]).toMatchObject({ ok: true, id: "c2", patch: { phone: "555" } });
  });

  it("todos Add: the title at commit is added; text typed after it stays in the input", async () => {
    h = await start([shellFeature, todosFeature], { "todos:api": createMemTodoApi({ delay: 5 }) });
    const u = user(h.store);
    await until(() => !!u.panel("todos.list"));
    const list = () => u.panel<TodosListProps>("todos.list")?.props as TodosListProps;
    h.dispatch(todosListIntents.newTitle({ title: "Feed cat" }));
    u.press(u.action(list().toolbar, "Add"));
    h.dispatch(todosListIntents.newTitle({ title: "Feed dog" }));
    await until(() => list().rows.length === 4 && !list().toolbar[0]?.running);
    expect(list().rows[3]?.title).toBe("Feed cat");
    expect(list().newTitle).toBe("Feed dog");
  });

  it("a cancelled editor ignores its save's late outcome; a newer session is not closed by it", async () => {
    const g = gate();
    const api = createMemTodoApi({ delay: () => g.wait() });
    h = await start([shellFeature, todosFeature], { "todos:api": api });
    const u = user(h.store);
    await until(() => g.pending > 0);
    g.release();
    await until(() => !!u.panel("todos.list"));
    const editor = () => u.panel<TodoEditorProps>("todos.edit")?.props;
    h.dispatch({ type: "todos/edit-open", id: "t1" } as Msg);
    h.dispatch(todoEditorIntents.title({ title: "Buy soy milk" }));
    u.press(editor()?.save);
    u.press(editor()?.cancel);
    h.dispatch({ type: "todos/edit-open", id: "t2" } as Msg); // a new session
    await until(() => g.pending > 0);
    g.openAll();
    await until(
      () => u.panel<TodosListProps>("todos.list")?.props.rows[0]?.title === "Buy soy milk",
    );
    expect(editor()?.title).toBe("Write report"); // the save landed; the new session is untouched
  });
});
