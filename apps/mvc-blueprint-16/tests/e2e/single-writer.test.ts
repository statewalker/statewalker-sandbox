import { activate as contactsUiSpec } from "@b/contacts.ui.spec";
import { activate as helloUiSpec } from "@b/hello.ui.spec";
import { type ViewSpec, viewSpecsSlot } from "@b/shell/api/spec";
import { activate as todosUiSpec } from "@b/todos.ui.spec";
import { type Context, getSlots } from "@kernel";
import { mountSpec } from "@kit/spec-dom";
import { specComponent } from "@kit/spec-solid";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { describe, expect, it } from "vitest";
import { VIEW_WRITERS, viewModels } from "../support/view-models.js";

/**
 * Single writer THROUGH THE INTERPRETERS: every spec, mounted by each interpreter over a real
 * view facet whose members record their calls; every element then receives every event the
 * grammar knows (plain and Ctrl-click, input, change, submit). Every write that reaches the model
 * must be a view-side writer (P0's FIELD_WRITER) or an action's `submit`.
 */
type Calls = string[];
const READER = /^get[A-Z]|^on[A-Z].*Update$/;

/** A copy of the facet whose functions (and actions' `submit`) record their names. */
function recorded(model: Record<string, unknown>, calls: Calls): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(model)) {
    if (typeof v === "function")
      out[k] = (...args: unknown[]) => {
        if (!READER.test(k)) calls.push(k);
        return v(...args);
      };
    else if (v && typeof (v as { submit?: unknown }).submit === "function") {
      const action = v as { submit: () => void };
      out[k] = {
        ...action,
        submit: () => {
          calls.push(`${k}.submit`);
          action.submit();
        },
      };
    } else out[k] = v;
  }
  return out;
}

async function specs(): Promise<[string, ViewSpec][]> {
  const context: Context = {};
  for (const activate of [todosUiSpec, contactsUiSpec, helloUiSpec]) await activate(context);
  return [...getSlots(context).getSnapshot(viewSpecsSlot)].map(([id, c]) => [id, c.spec]);
}

const mounters = {
  dom: (spec: ViewSpec, host: HTMLElement, model: unknown) => mountSpec(spec, host, model),
  solid: (spec: ViewSpec, host: HTMLElement, model: unknown) =>
    render(() => createComponent(specComponent(spec), { model }), host),
};

function drive(host: HTMLElement): void {
  for (const el of [...host.querySelectorAll("*")]) {
    if (!host.contains(el)) continue;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    if (el instanceof HTMLInputElement && el.type !== "checkbox") el.value = "typed";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }
}

const isViewWrite = (call: string) => VIEW_WRITERS.test(call) || call.endsWith(".submit");

describe.each(["dom", "solid"] as const)("single writer through the %s interpreter", (tech) => {
  it("every spec, every event: only view-side intents and action submits reach the model", async () => {
    const models = viewModels();
    const seen = new Set<string>();
    for (const [id, spec] of await specs()) {
      const calls: Calls = [];
      const host = document.createElement("div");
      document.body.append(host);
      const unmount = mounters[tech](
        spec,
        host,
        recorded(models[id] as Record<string, unknown>, calls),
      );
      drive(host);
      unmount();
      host.remove();
      for (const c of calls) expect(isViewWrite(c), `${id}: ${c}`).toBe(true);
      for (const c of calls) seen.add(`${id} ${c}`);
    }
    // Not vacuous: the gestures did reach the model through the interpreter.
    for (const w of [
      "todos:list select",
      "todos:list setNewTitle",
      "todos:list toggle.submit",
      "todos:editor editField",
      "todos:editor save.submit",
      "contacts:list select",
      "contacts:editor editField",
      "hello:panel increment.submit",
    ])
      expect(seen, w).toContain(w);
  });

  it("negative control: handed a facet with a presentation writer, a hostile spec is caught", async () => {
    const calls: Calls = [];
    const host = document.createElement("div");
    document.body.append(host);
    const hostile: ViewSpec = {
      root: { el: "div", on: { click: { intent: "publishItems", args: [[]] } } },
    };
    // The grammar only says "a named intent"; the facet decides what exists. Given a CONTROL
    // facet's writer, validation passes — the single-writer guarantee is the view facet's (P0).
    const model = recorded({ publishItems: () => {} }, calls);
    const unmount = mounters[tech](hostile, host, model);
    drive(host);
    unmount();
    host.remove();
    expect(calls).toContain("publishItems");
    expect(calls.every(isViewWrite)).toBe(false);
  });
});
