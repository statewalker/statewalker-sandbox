import type { ContactEditorView } from "@b/contacts/api";
import { type JrView, jrViewsSlot } from "@b/shell/api/jr";
import type { TodoListView } from "@b/todos/api";
import { createStateStore } from "@json-render/core";
import { flattenToPointers } from "@json-render/core/store-utils";
import { modelStore } from "@kit/jr";
import { afterEach, describe, expect, it } from "vitest";
import { panel, type Running, start, until, workbenchHeadless } from "../support/harness.js";
import { contactList, todoList } from "../support/scenarios.js";

/**
 * Single writer through the adapter. json-render's store has one generic setter, `set(path, v)`,
 * reached by `$bindState` inputs and by the built-ins `setState`/`pushState`/`removeState`. The
 * adapter is the ONLY enforcement point: every pointer of every snapshot is tried, and only the
 * binding's form fields reach the model (as its intent mutator); everything else is refused and the
 * model is untouched.
 */
let r: Running | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

const viewOf = (running: Running, kind: string) =>
  running.slots.getSnapshot(jrViewsSlot).get(kind) as unknown as JrView<unknown>;

/** Every leaf pointer of a snapshot, plus every top-level key (a whole group). */
const pointers = (snapshot: Record<string, unknown>) => [
  ...new Set([
    ...Object.keys(snapshot).map((k) => `/${k}`),
    ...Object.keys(flattenToPointers(JSON.parse(JSON.stringify(snapshot)))),
  ]),
];

function tryEveryPath(view: JrView<unknown>, model: unknown, probe: () => unknown) {
  const refusals: string[] = [];
  const store = modelStore(view.bind(model), (m) => refusals.push(m));
  const writable = new Set(Object.keys(view.bind(model).writes ?? {}));
  const accepted: string[] = [];
  for (const path of pointers(store.state.getSnapshot())) {
    const before = probe();
    const n = refusals.length;
    store.state.set(path, "x");
    if (refusals.length === n) accepted.push(path);
    else expect(probe(), `refused ${path} but the model changed`).toEqual(before);
  }
  return { accepted, writable: [...writable], refusals };
}

describe("single writer through the adapter", () => {
  it("todos:list — only /newTitle is writable; every presentation, selection and action path is refused", async () => {
    r = await start(workbenchHeadless);
    await until(() => todoList(r as Running).getItems().length === 3);
    const model = todoList(r);
    const probe = () => ({
      items: model.getItems(),
      selection: model.getSelection(),
      outcome: model.getOutcome(),
      toggle: model.toggle.getState(),
    });
    const { accepted, writable, refusals } = tryEveryPath(viewOf(r, "todos:list"), model, probe);
    expect(accepted).toEqual(["/newTitle"]);
    expect(writable).toEqual(["/newTitle"]);
    expect(model.getNewTitle()).toBe("x"); // through setNewTitle, the model's intent
    expect(refusals.length).toBeGreaterThan(20);
    expect(refusals[0]).toMatch(/refused write/);
  });

  it("contacts:editor — only the three draft fields; status and actions are refused", async () => {
    r = await start(workbenchHeadless);
    await until(() => contactList(r as Running).getContacts().length === 3);
    contactList(r).select("c1");
    contactList(r).getSelectionActions()[0]?.action.submit();
    await until(() => panel(r?.slots as never, "contacts:editor") !== undefined);
    const model = panel<ContactEditorView>(r.slots, "contacts:editor")?.model as ContactEditorView;
    const probe = () => ({ status: model.getStatus(), save: model.save.getState() });
    const { accepted } = tryEveryPath(viewOf(r, "contacts:editor"), model, probe);
    expect(accepted.sort()).toEqual(["/draft/email", "/draft/name", "/draft/phone"]);
    expect(model.getDraft()).toEqual({ name: "x", email: "x", phone: "x" });
    expect(model.getStatus().dirty).toBe(true); // editField ran: the model derived its own status
  });

  it("an update() with one refused path writes nothing at all", async () => {
    r = await start(workbenchHeadless);
    await until(() => todoList(r as Running).getItems().length === 3);
    const model: TodoListView = todoList(r);
    const refusals: string[] = [];
    const store = modelStore(viewOf(r, "todos:list").bind(model), (m) => refusals.push(m));
    store.state.update({ "/newTitle": "sneaky", "/items": [] });
    expect(refusals).toHaveLength(1);
    expect(model.getNewTitle()).toBe("");
    expect(model.getItems()).toHaveLength(3);
  });

  it("submit reaches only the view's own actions; an unknown ref is refused", async () => {
    r = await start(workbenchHeadless);
    await until(() => todoList(r as Running).getItems().length === 3);
    const refusals: string[] = [];
    const store = modelStore(viewOf(r, "todos:list").bind(todoList(r)), (m) => refusals.push(m));
    store.handlers.submit?.({ ref: "toolbar/nope" });
    store.handlers.submit?.({ ref: "contacts:edit" });
    expect(refusals).toHaveLength(2);
  });

  it("negative control: json-render's own store takes any write — the rule is not vacuous", async () => {
    r = await start(workbenchHeadless);
    await until(() => todoList(r as Running).getItems().length === 3);
    const plain = createStateStore({ items: todoList(r).getItems() });
    plain.set("/items", []);
    expect(plain.get("/items")).toEqual([]);
  });
});

describe("the adapter keeps the model contract", () => {
  it("one subscription per group, released with the last listener; a no-op notifies no one", async () => {
    r = await start(workbenchHeadless);
    await until(() => todoList(r as Running).getItems().length === 3);
    const model = todoList(r);
    let subs = 0;
    let unsubs = 0;
    /** The model with every `onX` wrapped to count subscriptions (models are frozen: a copy). */
    const counted = (m: TodoListView): TodoListView => {
      const copy: Record<string, unknown> = {};
      for (const k of Object.keys(m)) {
        const v = (m as unknown as Record<string, unknown>)[k];
        copy[k] =
          k.startsWith("on") && typeof v === "function"
            ? (l: () => void) => {
                subs++;
                const off = (v as (l: () => void) => () => void)(l);
                return () => {
                  unsubs++;
                  off();
                };
              }
            : v;
      }
      return copy as unknown as TodoListView;
    };
    const store = modelStore(viewOf(r, "todos:list").bind(counted(model)), () => {});
    let calls = 0;
    const off1 = store.state.subscribe(() => calls++);
    const off2 = store.state.subscribe(() => calls++);
    // 4 value groups + 2 action lists = 6 (plus one per listed action, not counted: ActionViews).
    expect(subs).toBe(6);
    const snapshot = store.state.getSnapshot();
    model.select(model.getSelection()); // same ids: the model notifies or not; nothing changes
    model.setNewTitle(model.getNewTitle());
    expect(calls).toBe(0);
    expect(store.state.getSnapshot()).toBe(snapshot);
    model.setNewTitle("a");
    // Two groups changed — newTitle, and toolbar (Add becomes enabled): one notification per
    // changed group per listener. The adapter does not batch; neither does the model contract.
    expect(calls).toBe(4);
    expect(store.state.getSnapshot()).not.toBe(snapshot);
    expect(store.state.getSnapshot().items).toBe(snapshot.items); // untouched groups keep identity
    off1();
    expect(unsubs).toBe(0);
    off2();
    expect(unsubs).toBe(6);
  });
});
