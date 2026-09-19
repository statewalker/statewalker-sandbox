import { specGeneratorAdapter } from "@b/agent/api";
import { catalogSlot } from "@b/catalog/api";
import { getSlots, without } from "@kernel";
import { formatCoverage } from "@kit/host";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { todoForContact } from "../../src/bundles/agent.fixtures/fixtures.js";
import {
  agentHeadless,
  assistant,
  controlledGenerator,
  fixedGenerator,
  openAssistant,
} from "../support/agent.js";
import { coverageOf, errorLogs, menu, type Running, start, until } from "../support/harness.js";
import {
  contactList,
  contactsScenario,
  newTodoForContactScenario,
  todosScenario,
} from "../support/scenarios.js";

const groups = (r: Running) => [...new Set(menu(r.slots).map((m) => m.group))].sort();
const report = (label: string, r: Running) => {
  const text = formatCoverage(coverageOf(r.context));
  console.info(`[removal] without ${label}: ${text}`);
  return coverageOf(r.context);
};
const gen = (g: unknown) => ({ services: { [specGeneratorAdapter.key]: g } });

describe("J1 removal: start the agent workbench without a feature", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  it("the full agent workbench: P0's interactions pass; coverage complete", async () => {
    r = await start(agentHeadless, { config: { "agent:fixture-delay-ms": 0 } });
    await newTodoForContactScenario(r);
    expect(groups(r)).toEqual(["Assistant", "Contacts", "Hello", "Todos"]);
    expect(report("nothing", r)).toEqual({ unrendered: [], unobserved: [] });
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("without agent: menu item, panel and its dependants go; 0 errors; the catalog stays, unobserved", async () => {
    const { manifest, removed } = without(agentHeadless, "agent");
    expect(removed.sort()).toEqual(["agent", "agent.contacts", "agent.react", "agent.todos"]);
    r = await start(manifest);
    await todosScenario(r);
    await contactsScenario(r);
    expect(groups(r)).toEqual(["Contacts", "Hello", "Todos"]);
    expect(assistant(r)).toBeUndefined();
    const coverage = report("agent", r);
    expect(coverage.unrendered).toEqual([]);
    // The vocabulary is an extension point of its own: without its consumer it is reported.
    expect(coverage.unobserved.map((u) => u.slot).sort()).toEqual([
      "ui.react:catalog",
      "ui:catalog",
    ]);
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("without ui.catalog: the agent and all vocabulary go too; P0 unchanged", async () => {
    const { manifest, removed } = without(agentHeadless, "ui.catalog");
    expect(removed.sort()).toEqual([
      "agent",
      "agent.contacts",
      "agent.react",
      "agent.todos",
      "ui.badge",
      "ui.badge.react",
      "ui.catalog",
      "ui.catalog.react",
    ]);
    r = await start(manifest);
    await newTodoForContactScenario(r);
    expect(report("ui.catalog", r)).toEqual({ unrendered: [], unobserved: [] });
    expect(
      r.slots.usage().filter((u) => /^(?:ui:catalog|ui\.react:catalog|agent:)/.test(u.key)),
    ).toEqual([]);
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("without todos: todos.compose leaves the prompt; a spec that binds it is refused", async () => {
    const c = controlledGenerator();
    const { manifest, removed } = without(agentHeadless, "todos");
    expect(removed).toContain("agent.todos");
    r = await start(manifest, gen(c.generator));
    const view = await openAssistant(r);
    await until(() => c.requests.length === 1);
    expect(c.requests[0]?.system).not.toContain("todos.compose");
    expect(c.requests[0]?.system).toContain("contacts.edit.open");
    c.push(`${todoForContact}\n`);
    c.end();
    await until(() => view.getStatus().phase !== "streaming");
    expect(view.getStatus().phase).toBe("invalid");
    expect(view.getStatus().issues.join("\n")).toMatch(/"todos.compose" is not allow-listed/);
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("without ui.badge: Badge leaves the prompt and the catalog; the recording still renders", async () => {
    const c = controlledGenerator();
    r = await start(without(agentHeadless, "ui.badge").manifest, gen(c.generator));
    await openAssistant(r);
    await until(() => c.requests.length === 1);
    expect(c.requests[0]?.system).not.toContain("- Badge:");
    await r.stop();
    r = await start(
      without(agentHeadless, "ui.badge").manifest,
      gen(fixedGenerator(todoForContact)),
    );
    await until(() => contactList(r as Running).getContacts().length === 3);
    const view = await openAssistant(r);
    await until(() => view.getStatus().phase === "ready");
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("the agent's React renderer missing: coverage reports the generated panel unrendered", async () => {
    const { manifest } = without(agentHeadless, "agent.react");
    r = await start(manifest, gen(fixedGenerator(todoForContact)));
    await openAssistant(r);
    expect(report("agent.react", r).unrendered).toEqual([
      { slot: "shell:panels", id: "agent:assistant", kind: "jr:generated" },
    ]);
  });
});

describe("J1: vocabulary clashes", () => {
  it("a second bundle contributing an existing component name fails its activation, loudly", async () => {
    const clash = {
      id: "test.clash",
      requires: ["ui.catalog"],
      bundles: [
        {
          id: "test.clash",
          activator: async (context: Record<string, unknown>) =>
            getSlots(context).register(catalogSlot, "Button", {
              props: z.object({}),
              slots: [],
              events: ["press"],
              description: "another button",
            }),
        },
      ],
    };
    await expect(
      start({ id: "clash", features: [...agentHeadless.features, clash] }),
    ).rejects.toThrow(/id "Button" is already registered/);
  });
});
