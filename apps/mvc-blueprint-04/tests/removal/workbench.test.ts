import { without } from "@kernel";
import { formatCoverage } from "@kit/host";
import { afterEach, describe, expect, it } from "vitest";
import {
  coverageOf,
  errorLogs,
  header,
  menu,
  panel,
  type Running,
  start,
  workbenchHeadless,
} from "../support/harness.js";
import {
  contactsScenario,
  headerCountScenario,
  newTodoForContactScenario,
  todosScenario,
} from "../support/scenarios.js";

const groups = (r: Running) => [...new Set(menu(r.slots).map((m) => m.group))].sort();

describe("the workbench, headless: interactions (1)–(3)", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  it("(1) New todo for this contact", async () => {
    r = await start(workbenchHeadless);
    await newTodoForContactScenario(r);
  });

  it("(2) the header count follows toggles and adds", async () => {
    r = await start(workbenchHeadless);
    const run = r;
    await headerCountScenario(r, () => header(run.slots));
  });

  it("(3) both apps' groups in one menu", async () => {
    r = await start(workbenchHeadless);
    expect(groups(r)).toEqual(["Contacts", "Hello", "Todos"]);
    expect(errorLogs(r.logs)).toEqual([]);
    expect(coverageOf(r.context)).toEqual({
      unrendered: [],
      unobserved: [{ slot: "todos:selection", contributions: 1 }],
    });
  });
});

describe("removal: start the workbench without a feature", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  const run = async (feature: string) => {
    const { manifest, removed } = without(workbenchHeadless, feature);
    r = await start(manifest);
    return { r, removed };
  };

  const report = (label: string, running: Running) => {
    const text = formatCoverage(coverageOf(running.context));
    console.info(`[removal] without ${label}: ${text}`);
    return text;
  };

  it("without todos-contacts: both apps work; the link is gone; nothing else changes", async () => {
    const { r, removed } = await run("todos-contacts");
    expect(removed).toEqual(["todos-contacts"]);
    await todosScenario(r);
    await contactsScenario(r);
    expect(groups(r)).toEqual(["Contacts", "Hello", "Todos"]);
    expect(errorLogs(r.logs)).toEqual([]);
    report("todos-contacts", r);
    expect(coverageOf(r.context).unrendered).toEqual([]);
  });

  it("without todos.status: no header item; everything else passes", async () => {
    const { r } = await run("todos.status");
    await todosScenario(r);
    await newTodoForContactScenario(r);
    expect(header(r.slots)).toEqual([]);
    expect(errorLogs(r.logs)).toEqual([]);
    report("todos.status", r);
  });

  it("without contacts: its menu group goes (and todos-contacts, which requires it)", async () => {
    const { r, removed } = await run("contacts");
    expect(removed.sort()).toEqual(["contacts", "contacts.react", "todos-contacts"]);
    await todosScenario(r);
    expect(groups(r)).toEqual(["Hello", "Todos"]);
    expect(panel(r.slots, "contacts:list")).toBeUndefined();
    expect(errorLogs(r.logs)).toEqual([]);
    report("contacts", r);
  });

  it("without todos: its menu group, panels and header item go", async () => {
    const { r, removed } = await run("todos");
    expect(removed.sort()).toEqual(["todos", "todos-contacts", "todos.react", "todos.status"]);
    await contactsScenario(r);
    expect(groups(r)).toEqual(["Contacts", "Hello"]);
    expect(header(r.slots)).toEqual([]);
    expect(errorLogs(r.logs)).toEqual([]);
    report("todos", r);
  });

  it("todos-contacts kept while contacts is removed: a loader error before anything activates", async () => {
    const broken = {
      ...workbenchHeadless,
      features: workbenchHeadless.features.filter(
        (f) => f.id !== "contacts" && f.id !== "contacts.react",
      ),
    };
    await expect(start(broken)).rejects.toThrow(/requires missing feature "contacts"/);
  });
});
