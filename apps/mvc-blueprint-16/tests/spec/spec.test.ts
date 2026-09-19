import { activate as contactsUiSpec } from "@b/contacts.ui.spec";
import { activate as helloUiSpec } from "@b/hello.ui.spec";
import type { ActionName, Handler, IntentName, ReadPath, ViewSpec } from "@b/shell/api/spec";
import { viewSpecsSlot } from "@b/shell/api/spec";
import type { TitleFormView, TodoListView } from "@b/todos/api";
import { activate as todosUiSpec } from "@b/todos.ui.spec";
import { type Context, getSlots } from "@kernel";
import { evaluate, groupsOf, SpecError, validate } from "@kit/spec";
import { describe, expect, it } from "vitest";
import { VIEW_WRITERS, viewModels } from "../support/view-models.js";

async function contributedSpecs(): Promise<Map<string, ViewSpec>> {
  const context: Context = {};
  for (const activate of [todosUiSpec, contactsUiSpec, helloUiSpec]) await activate(context);
  return new Map([...getSlots(context).getSnapshot(viewSpecsSlot)].map(([id, c]) => [id, c.spec]));
}

/** Every write a spec can make: `intent:<name>` and `submit:<action>`, collected from the tree. */
function writesOf(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const y of x) writesOf(y, out);
  else if (typeof x === "object" && x !== null) {
    const o = x as Record<string, unknown>;
    if (typeof o.intent === "string") out.add(`intent:${o.intent}`);
    if (typeof o.submit === "string") out.add(`submit:${o.submit}`);
    for (const v of Object.values(o)) writesOf(v, out);
  }
  return out;
}

describe("the specs", () => {
  it("one spec per view kind of the benchmark (8 kinds, 7 distinct specs)", async () => {
    const specs = await contributedSpecs();
    expect([...specs.keys()].sort()).toEqual([
      "contacts:details",
      "contacts:editor",
      "contacts:list",
      "hello:panel",
      "todos:clear-completed",
      "todos:editor",
      "todos:list",
      "todos:rename",
    ]);
    expect(new Set(specs.values()).size).toBe(7); // the rename dialog reuses the editor's spec
  });

  it("are JSON: a round trip through JSON.stringify changes nothing", async () => {
    for (const [id, spec] of await contributedSpecs())
      expect(JSON.parse(JSON.stringify(spec)), id).toEqual(spec);
  });

  it("validate against the real view facet of their kind", async () => {
    const models = viewModels();
    for (const [id, spec] of await contributedSpecs())
      expect(() => validate(spec, models[id]), id).not.toThrow();
  });

  it("single writer by grammar: every write is a view-side intent or an action submit", async () => {
    const all = new Set<string>();
    for (const spec of (await contributedSpecs()).values())
      for (const w of writesOf(spec)) all.add(w);
    expect([...all].sort()).toEqual([
      "intent:editField",
      "intent:select",
      "intent:setNewTitle",
      "submit:save",
      "submit:toggle",
    ]);
    for (const w of all)
      expect(w.startsWith("submit:") || VIEW_WRITERS.test(w.slice(7)), w).toBe(true);
  });

  it("reads name groups; the list spec subscribes 6 groups, the details spec 1", async () => {
    const specs = await contributedSpecs();
    expect([...groupsOf(specs.get("todos:list"))].sort()).toEqual([
      "items",
      "newTitle",
      "outcome",
      "selection",
      "selectionActions",
      "toolbar",
    ]);
    expect([...groupsOf(specs.get("contacts:details"))]).toEqual(["contact"]);
  });
});

describe("validation fails loudly (negative controls)", () => {
  const models = viewModels();
  const list = models["todos:list"];
  const form = models["todos:editor"];
  const bad = (root: unknown, model: unknown) => () => validate({ root } as ViewSpec, model);

  it.each([
    ["an unknown group", { text: { read: "itemz" } }, list, /no group "itemz"/],
    [
      "a misspelt intent",
      { el: "input", on: { input: { intent: "setNewTitel" } } },
      list,
      /not an intent/,
    ],
    [
      "a presentation group as a write target",
      { el: "li", on: { click: { intent: "getItems" } } },
      list,
      /not an intent/,
    ],
    [
      "a subscriber as an intent",
      { el: "li", on: { click: { intent: "onItemsUpdate" } } },
      list,
      /not an intent/,
    ],
    [
      "a presentation writer the view facet does not have",
      { el: "li", on: { click: { intent: "publishItems" } } },
      list,
      /not an intent/,
    ],
    [
      "submitting a group",
      { el: "form", on: { submit: { submit: "draft" } } },
      form,
      /not an action/,
    ],
    [
      "a path write",
      { el: "input", on: { input: { set: "draft.title", value: { event: "value" } } } },
      form,
      /a handler is/,
    ],
    [
      "a json-render-style setState",
      { el: "input", on: { input: { setState: "/draft/title" } } },
      form,
      /a handler is/,
    ],
    [
      "a two-way path binding",
      { el: "input", attrs: { value: { bindState: "/draft/title" } } },
      form,
      /unknown expression/,
    ],
    ["an unknown node", { watch: { read: "draft" } }, form, /unknown node/],
    ["an unknown tag", { el: "script" }, form, /unknown tag/],
    [
      "an unknown event",
      { el: "div", on: { mouseover: { submit: "save" } } },
      form,
      /unknown event/,
    ],
    ["an action that is not one", { action: "draft" }, form, /not an action/],
  ])("%s", (_label, root, model, message) => {
    expect(bad(root, model)).toThrow(SpecError);
    expect(bad(root, model)).toThrow(message);
  });
});

describe("type-level: tsc rejects a spec that names what the model does not offer", () => {
  it("compiles (see `pnpm typecheck`)", () => {
    const ok: IntentName<TodoListView>[] = ["select", "setNewTitle"];
    // @ts-expect-error — a misspelt intent
    const i1: IntentName<TodoListView> = "setNewTitel";
    // @ts-expect-error — a getter is not an intent
    const i2: IntentName<TitleFormView> = "getDraft";
    // @ts-expect-error — a subscriber is not an intent
    const i3: IntentName<TodoListView> = "onItemsUpdate";
    // @ts-expect-error — an unknown group
    const r1: ReadPath<TodoListView> = "itemz";
    // @ts-expect-error — a group is not an action
    const a1: ActionName<TitleFormView> = "draft";
    // @ts-expect-error — the grammar has no path write
    const h1: Handler<TitleFormView> = { set: "draft.title" };
    expect([ok, i1, i2, i3, r1, a1, h1]).toHaveLength(7);
  });
});

describe("expressions", () => {
  const s = {
    read: (g: string) => ({ selection: ["a", "b"], draft: { title: "T" } })[g],
    item: { id: "b" },
  };
  it("toggle, includes, if, concat, eq, paths, arrays", () => {
    expect(evaluate({ toggle: [{ read: "selection" }, { item: "id" }] }, s)).toEqual(["a"]);
    expect(evaluate({ toggle: [{ read: "selection" }, "c"] }, s)).toEqual(["a", "b", "c"]);
    expect(evaluate({ includes: [{ read: "selection" }, { item: "id" }] }, s)).toBe(true);
    expect(evaluate({ if: [{ eq: [{ item: "id" }, "b"] }, "yes"] }, s)).toBe("yes");
    expect(evaluate({ if: [false, "yes"] }, s)).toBeNull();
    expect(evaluate({ concat: ["Title: ", { read: "draft.title" }] }, s)).toBe("Title: T");
    expect(evaluate([{ item: "id" }], s)).toEqual(["b"]);
    expect(evaluate({ event: "extend" }, { ...s, event: { extend: true } })).toBe(true);
  });
});
