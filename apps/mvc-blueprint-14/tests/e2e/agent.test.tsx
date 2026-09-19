import { specGeneratorAdapter } from "@b/agent/api";
import { catalogSlot } from "@b/catalog/api";
import { reactCatalogSlot } from "@b/catalog/api/react";
import { shellRoot } from "@b/shell/api";
import { useActions, useStateStore } from "@json-render/react";
import {
  type ApplicationManifest,
  application,
  type Context,
  configAdapter,
  type FeatureManifest,
  getCommands,
  getSlots,
  loggerAdapter,
  newRegistry,
} from "@kernel";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { workbenchAgent } from "../../src/apps/workbench.agent.js";
import { todoForContact } from "../../src/bundles/agent.fixtures/fixtures.js";
import { add, controlledGenerator, el, jsonl, spyCommands } from "../support/agent.js";
import { type LoggedCall, newRecordingLogger } from "../support/logging.js";
import { all, button, click, typeInto, waitFor } from "./dom.js";
import {
  contactsEdit,
  headerCount,
  menus,
  newTodoForContact,
  q,
  renameTodo,
  todosBasics,
} from "./scenarios.js";

interface AgentPage {
  readonly root: HTMLElement;
  readonly context: Context;
  readonly logs: LoggedCall[];
  readonly errors: () => unknown[];
  stop(): Promise<void>;
}

async function openAgent(
  manifest: ApplicationManifest,
  services: Record<string, unknown> = {},
): Promise<AgentPage> {
  const root = document.createElement("div");
  document.body.append(root);
  const context: Context = { ...services };
  const { logger, calls } = newRecordingLogger();
  loggerAdapter.set(context, logger);
  configAdapter.set(
    context,
    Object.freeze({ "shell:notification-timeout-ms": 60_000, "agent:fixture-delay-ms": 5 }),
  );
  shellRoot.set(context, root);
  const stop = await application(manifest)(context);
  return {
    root,
    context,
    logs: calls,
    errors: () => calls.filter((c) => c.level === "error" || c.level === "fatal"),
    async stop() {
      await stop?.();
      root.remove();
    },
  };
}

const errors = (p: AgentPage) => p.logs.filter((l) => l.level === "error" || l.level === "fatal");
const panelOf = (p: AgentPage) =>
  p.root.querySelector<HTMLElement>('[data-panel="agent:assistant"]');
const status = (p: AgentPage) =>
  panelOf(p)?.querySelector("[data-generated]")?.getAttribute("data-status");
const jr = (p: AgentPage, type: string) => all(panelOf(p) ?? p.root, `[data-jr="${type}"]`);
const titleInput = (p: AgentPage) =>
  panelOf(p)?.querySelector<HTMLInputElement>('[data-jr="Input"] input') ?? null;
const create = (p: AgentPage) => button(panelOf(p) as HTMLElement, "Create");

async function selectAdaAndAsk(p: AgentPage) {
  const $ = q(p as never);
  await waitFor(() => $.contactRow("Ada Lovelace") !== undefined);
  click($.contactRow("Ada Lovelace"));
  await waitFor(() => $.panel("contacts:details") !== null);
  click($.menuItem("Assistant…"));
  await waitFor(() => panelOf(p) !== null);
}

describe("J1 in the browser (React): a generated panel", () => {
  let page: AgentPage | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  it("interaction (1) through a generated UI: recorded stream → panel → Create → editor → todo", async () => {
    page = await openAgent(workbenchAgent);
    const p = page;
    await selectAdaAndAsk(p);
    await waitFor(() => status(p) === "ready");
    expect(jr(p, "Card")[0]?.querySelector("h3")?.textContent).toBe(
      "New todo for the selected contact",
    );
    expect(jr(p, "Table")[0]?.querySelector("tbody")?.textContent).toContain("Ada Lovelace");
    expect(titleInput(p)?.value).toBe("Call Ada Lovelace");
    click(create(p));
    const $ = q(p as never);
    await waitFor(() => $.panel("todos:editor") !== null);
    const editor = $.panel("todos:editor") as HTMLElement;
    expect(editor.querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value).toBe(
      "Call Ada Lovelace",
    );
    click(button(editor, "Save"));
    await waitFor(() => $.todoTitles().includes("Call Ada Lovelace"));
    await waitFor(
      () =>
        panelOf(p)?.querySelector("[data-generated-outcome]")?.textContent ===
        "Done: todos.compose",
    );
    click(button(panelOf(p) as HTMLElement, "Close"));
    await waitFor(() => panelOf(p) === null);
    expect(errors(p)).toEqual([]);
  });

  it("partial rendering: the valid prefix shows while streaming; Create is inert until complete", async () => {
    const c = controlledGenerator();
    page = await openAgent(workbenchAgent, { [specGeneratorAdapter.key]: c.generator });
    const p = page;
    await selectAdaAndAsk(p);
    const lines = todoForContact.split("\n").map((l) => `${l}\n`);
    c.push(...lines.slice(0, 3));
    await waitFor(() => jr(p, "Text").length === 1);
    expect(jr(p, "Card")).toHaveLength(1);
    expect(jr(p, "Table")).toHaveLength(0);
    expect(panelOf(p)?.querySelector("[data-generated-status]")?.textContent).toBe("Generating…");
    c.push(...lines.slice(3));
    await waitFor(() => create(p) !== undefined);
    expect(create(p)?.disabled).toBe(true); // no action exists for a partial spec
    expect(titleInput(p)?.value).toBe("Call Ada Lovelace");
    c.end();
    await waitFor(() => status(p) === "ready");
    await waitFor(() => create(p)?.disabled === false);
  });

  it("an invalid element mid-stream: nothing of the spec stays on screen; the issues are listed", async () => {
    const c = controlledGenerator();
    page = await openAgent(workbenchAgent, { [specGeneratorAdapter.key]: c.generator });
    const p = page;
    await selectAdaAndAsk(p);
    c.push(
      ...todoForContact
        .split("\n")
        .slice(0, 3)
        .map((l) => `${l}\n`),
    );
    await waitFor(() => jr(p, "Text").length === 1);
    c.push(...jsonl(add("/elements/x", el("Iframe", { src: "https://evil.example" }))));
    await waitFor(() => status(p) === "invalid");
    expect(all(panelOf(p) as HTMLElement, "[data-jr]")).toEqual([]);
    expect(panelOf(p)?.querySelector('[role="alert"]')?.textContent).toMatch(/elements\.x\.type/);
    expect(p.root.querySelector("iframe")).toBeNull();
    expect(errors(p)).toEqual([]);
  });

  it("commit time through the DOM: type, press, type again in one tick → the press-time title", async () => {
    page = await openAgent(workbenchAgent);
    const p = page;
    const calls = spyCommands(getCommands(p.context));
    await selectAdaAndAsk(p);
    await waitFor(() => status(p) === "ready" && create(p)?.disabled === false);
    typeInto(titleInput(p), "A");
    click(create(p));
    typeInto(titleInput(p), "B");
    click(create(p)); // a double press in the same tick is refused
    const $ = q(p as never);
    await waitFor(() => $.panel("todos:editor") !== null);
    await waitFor(() => create(p)?.disabled === false);
    expect(calls.filter((x) => x.key === "todos:compose").map((x) => x.payload)).toEqual([
      { title: "A" },
    ]);
    expect(
      ($.panel("todos:editor") as HTMLElement).querySelector<HTMLInputElement>(
        'input[aria-label="Title"]',
      )?.value,
    ).toBe("A");
    expect(titleInput(p)?.value).toBe("B");
  });
});

/**
 * The second line of defence, reached WITHOUT the policy: a catalog component whose React
 * implementation goes around our `write`/`action` capabilities and uses json-render's own hooks —
 * a direct store write and the `setState` built-in. Both land on the model's store facade, which
 * refuses and logs them; no model changes.
 */
const rogueFeature: FeatureManifest = {
  id: "test.rogue",
  requires: ["ui.catalog.react"],
  bundles: [
    {
      id: "test.rogue",
      activator: async (context) => {
        const slots = getSlots(context);
        const [register, cleanup] = newRegistry();
        register(
          slots.register(catalogSlot, "Rogue", {
            props: z.object({}),
            slots: [],
            events: [],
            description: "test only",
          }),
        );
        register(slots.register(reactCatalogSlot, "Rogue", { component: Rogue as never }));
        return cleanup;
      },
    },
  ],
};

function Rogue() {
  const store = useStateStore();
  const { execute } = useActions();
  return (
    <button
      type="button"
      data-rogue
      onClick={() => {
        store.set("/data/selectedContacts", []);
        store.set("/form/title", "written by json-render");
        void execute({ action: "setState", params: { statePath: "/anything", value: 1 } });
        void execute({
          action: "pushState",
          params: { statePath: "/data/selectedContacts", value: {} },
        });
      }}
    >
      rogue
    </button>
  );
}

describe("J1 in the browser: json-render's own write paths hit the store facade", () => {
  let page: AgentPage | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  it("direct store writes and built-ins outside /form/<seeded> are refused and logged", async () => {
    const c = controlledGenerator();
    page = await openAgent(
      { id: "workbench.agent+rogue", features: [...workbenchAgent.features, rogueFeature] },
      { [specGeneratorAdapter.key]: c.generator },
    );
    const p = page;
    await selectAdaAndAsk(p);
    c.push(
      ...jsonl(
        add("/root", "card"),
        add(
          "/elements/card",
          el("Card", { title: "T" }, { children: ["people", "title", "rogue"] }),
        ),
        add(
          "/elements/people",
          el("Table", {
            columns: [{ key: "name", label: "Name" }],
            rows: { $state: "/data/selectedContacts" },
          }),
        ),
        add(
          "/elements/title",
          el("Input", { label: "Title", value: { $bindState: "/form/title" } }),
        ),
        add("/state/form", { title: "seeded" }),
        add("/elements/rogue", el("Rogue", {})),
      ),
    );
    c.end();
    await waitFor(() => status(p) === "ready");
    click(p.root.querySelector("[data-rogue]"));
    await waitFor(
      () =>
        p.logs.filter((l) => l.args[0] === "agent: refused a write outside the form group")
          .length === 3,
    );
    const refused = p.logs
      .filter((l) => l.args[0] === "agent: refused a write outside the form group")
      .map((l) => (l.args[1] as { path: string }).path);
    expect(refused).toEqual(["/data/selectedContacts", "/anything", "/data/selectedContacts"]);
    // The one legal path went through the form group's intent (the same as typing).
    await waitFor(() => titleInput(p)?.value === "written by json-render");
    expect(jr(p, "Table")[0]?.querySelector("tbody")?.textContent).toContain("Ada Lovelace");
    expect(errors(p)).toEqual([]);
  });
});

describe("P0's scenarios on the agent workbench (nothing of P0 changed behaviour)", () => {
  let page: AgentPage | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  it.each([
    ["Todos basics", todosBasics],
    ["Contacts edit", contactsEdit],
    ["(1) New todo for this contact", newTodoForContact],
    ["(2) header count", headerCount],
    ["Rename a todo", renameTodo],
  ] as const)("%s", async (_name, scenario) => {
    page = await openAgent(workbenchAgent);
    await scenario(page as never);
    expect(errors(page)).toEqual([]);
  });

  it("(3) one main menu with every group, the Assistant's included", async () => {
    page = await openAgent(workbenchAgent);
    await menus(page as never, ["Assistant", "Contacts", "Hello", "Todos"]);
  });
});
