/**
 * The road not taken: classic TEA composition (wrapper Msg + Cmd.map + nested update) for the
 * same shape — two apps and the "New todo for this contact" link — to compare with R1's
 * update-function extension point. Everything here is self-contained and deliberately minimal.
 *
 * What it shows (asserted below, measured in LESSONS.md):
 *   - the parent imports every child's init/update and names every child in its Model and Msg;
 *   - a cross-app interaction has nowhere to live but the parent: the parent intercepts one
 *     child's message and synthesises another child's (so the link edits the parent);
 *   - removing a child means editing the parent.
 */
import { describe, expect, it } from "vitest";

type Cmd<M> = { run: "api"; payload: string; then: (result: string) => M }[];
const none: Cmd<never> = [];
const mapCmd = <A, B>(cmd: Cmd<A>, f: (a: A) => B): Cmd<B> =>
  cmd.map((c) => ({ ...c, then: (r: string) => f(c.then(r)) }));

// ---- child 1: todos -------------------------------------------------------------------------
type TodosModel = { titles: string[]; composing?: string };
type TodosMsg = { t: "compose"; title: string } | { t: "save" } | { t: "saved"; title: string };
const todos = {
  init: (): TodosModel => ({ titles: ["Buy milk"] }),
  update(m: TodosModel, msg: TodosMsg): [TodosModel, Cmd<TodosMsg>] {
    switch (msg.t) {
      case "compose":
        return [{ ...m, composing: msg.title }, none];
      case "save":
        return m.composing === undefined
          ? [m, none]
          : [m, [{ run: "api", payload: m.composing, then: (title) => ({ t: "saved", title }) }]];
      case "saved":
        return [{ titles: [...m.titles, msg.title] }, none];
    }
  },
};

// ---- child 2: contacts ----------------------------------------------------------------------
type ContactsModel = { names: string[]; selected?: string };
type ContactsMsg = { t: "select"; name: string } | { t: "action"; id: string };
const contacts = {
  init: (): ContactsModel => ({ names: ["Ada Lovelace", "Alan Turing"] }),
  update(m: ContactsModel, msg: ContactsMsg): [ContactsModel, Cmd<ContactsMsg>] {
    if (msg.t === "select") return [{ ...m, selected: msg.name }, none];
    return [m, none]; // "action" is not Contacts' business: it does not know "new todo"
  },
};

// ---- the parent: knows both, routes and translates ------------------------------------------
type Model = { todos: TodosModel; contacts: ContactsModel };
type Msg = { t: "todos"; inner: TodosMsg } | { t: "contacts"; inner: ContactsMsg };
const parent = {
  init: (): Model => ({ todos: todos.init(), contacts: contacts.init() }),
  update(m: Model, msg: Msg): [Model, Cmd<Msg>] {
    if (msg.t === "todos") {
      const [t, cmd] = todos.update(m.todos, msg.inner);
      return [{ ...m, todos: t }, mapCmd(cmd, (inner): Msg => ({ t: "todos", inner }))];
    }
    // The link lives HERE: the parent intercepts a Contacts message and synthesises a Todos one.
    if (msg.inner.t === "action" && msg.inner.id === "new-todo" && m.contacts.selected) {
      return parent.update(m, { t: "todos", inner: { t: "compose", title: m.contacts.selected } });
    }
    const [c, cmd] = contacts.update(m.contacts, msg.inner);
    return [{ ...m, contacts: c }, mapCmd(cmd, (inner): Msg => ({ t: "contacts", inner }))];
  },
};

function runtime() {
  let model = parent.init();
  const dispatch = (msg: Msg) => {
    const [next, cmd] = parent.update(model, msg);
    model = next;
    for (const c of cmd) dispatch(c.then(c.payload)); // a synchronous "api"
  };
  return { dispatch, get: () => model };
}

describe("classic TEA nesting (comparison)", () => {
  it("works: the link composes a todo from the selected contact, at commit time", () => {
    const rt = runtime();
    rt.dispatch({ t: "contacts", inner: { t: "select", name: "Alan Turing" } });
    rt.dispatch({ t: "contacts", inner: { t: "action", id: "new-todo" } });
    expect(rt.get().todos.composing).toBe("Alan Turing");
    rt.dispatch({ t: "todos", inner: { t: "save" } });
    expect(rt.get().todos.titles).toEqual(["Buy milk", "Alan Turing"]);
  });

  it("costs: the parent names every child, and the link is parent code", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL(import.meta.url), "utf8");
    const parentSrc = src.slice(src.indexOf("// ---- the parent"), src.indexOf("function runtime"));
    // Every child is named in the parent's Model, Msg, init and update:
    expect(parentSrc.match(/\btodos\b/g)?.length).toBeGreaterThanOrEqual(6);
    expect(parentSrc.match(/\bcontacts\b/g)?.length).toBeGreaterThanOrEqual(6);
    // …and the cross-app interaction is a branch in the parent, not a separate unit:
    expect(parentSrc).toContain('msg.inner.id === "new-todo"');
  });
});
