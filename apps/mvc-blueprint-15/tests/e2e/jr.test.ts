import { MemContactsApi } from "@b/contacts.core";
import { panelsSlot } from "@b/shell/api";
import { type JrView, jrViewsSlot } from "@b/shell/api/jr";
import { MemTodoApi } from "@b/todos.core";
import {
  type ActionState,
  type ApplicationManifest,
  type Controller,
  defineViewKind,
  getSlots,
  type Listener,
} from "@kernel";
import { afterEach, describe, expect, it } from "vitest";
import { type Technology, technologies, workbench } from "../../src/apps/workbenches.js";
import { all, button, click, open, type Page, typeInto, waitFor } from "./dom.js";
import { q } from "./scenarios.js";

/**
 * json-render between the page and the models, under both technologies:
 * - negative controls for single writer: a spec that binds a presentation path, or emits the
 *   built-ins `setState` / `pushState` / `removeState`, fails loudly (an error log) and writes nothing;
 * - commit time and double press THROUGH the spec: a click is `emit` → handler → `submit()`.
 */
const TECHS = ["react", "solid"] as const;
const DELAY = 30;
const flush = () => new Promise((r) => setTimeout(r, 0));

// ── a hostile spec over a hand-rolled model ────────────────────────────────────────────────────
interface CounterView {
  getCount(): number;
  onCountUpdate(l: Listener): () => void;
  readonly increment: {
    getState(): ActionState;
    onStateUpdate(l: Listener): () => void;
    submit(): void;
  };
}
const evilKind = defineViewKind<CounterView>("evil:panel");
const evilSpec = {
  root: "root",
  elements: {
    root: {
      type: "Stack",
      props: { direction: "column" },
      children: ["count", "set", "push", "remove"],
    },
    count: {
      type: "TextInput",
      props: { label: "Count", value: { $bindState: "/count" } },
      children: [],
    },
    set: {
      type: "Button",
      props: { action: { label: "setState", enabled: true, running: false } },
      on: { press: { action: "setState", params: { statePath: "/count", value: 99 } } },
      children: [],
    },
    push: {
      type: "Button",
      props: { action: { label: "pushState", enabled: true, running: false } },
      on: { press: { action: "pushState", params: { statePath: "/list", value: 1 } } },
      children: [],
    },
    remove: {
      type: "Button",
      props: { action: { label: "removeState", enabled: true, running: false } },
      on: { press: { action: "removeState", params: { statePath: "/list", index: 0 } } },
      children: [],
    },
  },
};

function evilApp(tech: Technology) {
  let count = 0;
  const listeners = new Set<Listener>();
  const idle: ActionState = { label: "+1", enabled: true, running: false };
  const model: CounterView = {
    getCount: () => count,
    onCountUpdate(l) {
      listeners.add(l);
      l();
      return () => listeners.delete(l);
    },
    increment: {
      getState: () => idle,
      onStateUpdate: (l) => {
        l();
        return () => {};
      },
      submit() {
        count++;
        for (const l of [...listeners]) l();
      },
    },
  };
  const activator: Controller = async (context) => {
    const slots = getSlots(context);
    const view: JrView<CounterView> = {
      kind: evilKind,
      spec: evilSpec,
      bind: (m) => ({
        values: { count: [m.getCount, m.onCountUpdate] },
        actions: { increment: m.increment },
      }),
    };
    const a = slots.register(jrViewsSlot, evilKind.id, view as unknown as JrView<never>);
    const b = slots.register(panelsSlot, "evil", {
      kind: evilKind,
      title: "Evil",
      placement: "main",
      model,
    });
    return () => {
      b();
      a();
    };
  };
  const ui = technologies[tech];
  const manifest: ApplicationManifest = {
    id: `evil.${tech}`,
    features: [ui.shell, ui.renderer, { id: "evil", bundles: [{ id: "evil", activator }] }],
  };
  return { manifest, count: () => count };
}

const refusedPaths = (page: Page) =>
  page
    .errors()
    .map((e) => JSON.stringify(e))
    .filter((e) => e.includes("refused write"));

describe.each(TECHS)("single writer through json-render — negative controls: %s", (tech) => {
  let page: Page | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  it("a spec binding a presentation path: typing is refused loudly, the model is untouched", async () => {
    const app = evilApp(tech);
    page = await open(app.manifest);
    const input = () => page?.root.querySelector<HTMLInputElement>('input[aria-label="Count"]');
    await waitFor(() => input()?.value === "0");
    typeInto(input(), "42");
    await flush();
    expect(app.count()).toBe(0);
    expect(refusedPaths(page)).toHaveLength(1);
    expect(refusedPaths(page)[0]).toContain("/count");
    // Controlled: the page shows the model's value again (React re-asserts it; the Solid catalog
    // puts it back itself — without that line Solid kept showing "42").
    await waitFor(() => input()?.value === "0");
  });

  it("the built-ins setState / pushState / removeState are refused loudly, the model is untouched", async () => {
    const app = evilApp(tech);
    page = await open(app.manifest);
    await waitFor(() => button(page?.root as HTMLElement, "setState") !== undefined);
    for (const name of ["setState", "pushState", "removeState"]) click(button(page.root, name));
    await flush();
    expect(app.count()).toBe(0);
    const refused = refusedPaths(page);
    expect(refused).toHaveLength(3);
    expect(refused.join()).toContain("/count");
    expect(refused.join()).toContain("/list");
  });
});

// ── commit time and double press through the spec ──────────────────────────────────────────────
describe.each(TECHS)("commit time through json-render: %s", (tech) => {
  let page: Page | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  async function renameDialog(api: MemTodoApi) {
    page = await open(workbench(tech), { "todos:api": api });
    const $ = q(page);
    await waitFor(() => $.todoTitles().length === 3);
    click($.todoRow("Buy milk"));
    const list = () => $.panel("todos:list") as HTMLElement;
    await waitFor(() => button(list(), "Rename…")?.disabled === false);
    click(button(list(), "Rename…"));
    await waitFor(() => $.dialog("todos:rename") !== null);
    return () => $.dialog("todos:rename") as HTMLElement;
  }
  const updates = (api: { calls: { method: string; args: unknown[] }[] }) =>
    api.calls.filter((c) => c.method === "update").map((c) => c.args[1]);

  it("Rename: typing in the same tick as the press is not committed", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    const dialog = await renameDialog(api);
    typeInto(dialog().querySelector('input[aria-label="Title"]'), "committed");
    await waitFor(() => button(dialog(), "Rename")?.disabled === false);
    click(button(dialog(), "Rename"));
    typeInto(dialog().querySelector('input[aria-label="Title"]'), "typed after");
    await waitFor(() => q(page as Page).dialog("todos:rename") === null);
    expect(updates(api)).toEqual([{ title: "committed" }]);
  });

  it("Rename: a double press in one tick is one commit", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    const dialog = await renameDialog(api);
    typeInto(dialog().querySelector('input[aria-label="Title"]'), "once");
    await waitFor(() => button(dialog(), "Rename")?.disabled === false);
    const rename = button(dialog(), "Rename");
    click(rename);
    click(rename); // same tick: the DOM has not re-rendered, the button is still enabled
    await waitFor(() => q(page as Page).dialog("todos:rename") === null);
    await new Promise((r) => setTimeout(r, DELAY * 2));
    expect(updates(api)).toEqual([{ title: "once" }]);
  });

  it("Contacts Save: a double press in one tick is one update; typing after it is not committed", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    page = await open(workbench(tech), { "contacts:api": api });
    const $ = q(page);
    await waitFor(() => $.contactRow("Alan Turing") !== undefined);
    click($.tab("Contacts"));
    click($.contactRow("Alan Turing"));
    const contacts = () => $.panel("contacts:list") as HTMLElement;
    await waitFor(() => button(contacts(), "Edit")?.disabled === false);
    click(button(contacts(), "Edit"));
    await waitFor(() => $.panel("contacts:editor") !== null);
    const editor = () => $.panel("contacts:editor") as HTMLElement;
    typeInto(editor().querySelector('input[aria-label="Email"]'), "alan@committed.org");
    await waitFor(() => button(editor(), "Save")?.disabled === false);
    const save = button(editor(), "Save");
    click(save);
    click(save);
    typeInto(editor().querySelector('input[aria-label="Email"]'), "typed after");
    await waitFor(() => $.panel("contacts:editor") === null);
    await new Promise((r) => setTimeout(r, DELAY * 2));
    expect(updates(api)).toEqual([
      { name: "Alan Turing", email: "alan@committed.org", phone: "+44 20 0002" },
    ]);
  });

  it("Delete: a double press in one tick with the selection changed between is one commit on the first selection", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    page = await open(workbench(tech), { "todos:api": api });
    const $ = q(page);
    await waitFor(() => $.todoTitles().length === 3);
    click($.todoRow("Buy milk"));
    const list = () => $.panel("todos:list") as HTMLElement;
    await waitFor(() => button(list(), "Delete")?.disabled === false);
    const del = button(list(), "Delete");
    click(del);
    click($.todoRow("Write report")); // same tick: re-select
    click(del);
    await waitFor(() => $.todoTitles().length === 2);
    await new Promise((r) => setTimeout(r, DELAY * 2));
    expect(api.calls.filter((c) => c.method === "remove").map((c) => c.args[0])).toEqual(["t1"]);
    expect($.todoTitles()).toEqual(["Write report", "Call plumber"]);
  });

  it("Add: two presses in one tick, a title typed between, are two commits (queued)", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    page = await open(workbench(tech), { "todos:api": api });
    const $ = q(page);
    await waitFor(() => $.todoTitles().length === 3);
    const list = () => $.panel("todos:list") as HTMLElement;
    const input = () => list().querySelector('input[aria-label="New todo"]');
    typeInto(input(), "one");
    await waitFor(() => button(list(), "Add")?.disabled === false);
    const add = button(list(), "Add");
    click(add);
    typeInto(input(), "two");
    click(add);
    await waitFor(() => $.todoTitles().length === 5);
    expect($.todoTitles().slice(3)).toEqual(["one", "two"]);
  });

  it("a press while running is refused: the button is disabled, a click does nothing", async () => {
    const api = new MemTodoApi(undefined, DELAY * 3);
    page = await open(workbench(tech), { "todos:api": api });
    const $ = q(page);
    await waitFor(() => $.todoTitles().length === 3);
    click($.todoRow("Buy milk"));
    const list = () => $.panel("todos:list") as HTMLElement;
    await waitFor(() => button(list(), "Delete")?.disabled === false);
    click(button(list(), "Delete"));
    await waitFor(() => button(list(), "Delete")?.getAttribute("aria-busy") === "true");
    click(button(list(), "Delete"));
    await waitFor(() => $.todoTitles().length === 2);
    await new Promise((r) => setTimeout(r, DELAY * 4));
    expect(api.calls.filter((c) => c.method === "remove")).toHaveLength(1);
    expect(all(page.root, '[data-notification][role="alert"]')).toEqual([]);
  });
});
