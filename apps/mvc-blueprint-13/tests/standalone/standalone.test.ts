import { afterEach, describe, expect, it } from "vitest";
import {
  contactsHeadless,
  coverageOf,
  errorLogs,
  menu,
  type Running,
  start,
  todosHeadless,
} from "../support/harness.js";
import { contactsScenario, todosScenario } from "../support/scenarios.js";

describe("standalone runs in the headless test shell", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  it("Todos alone: the whole Todos suite, no Contacts code loaded", async () => {
    r = await start(todosHeadless);
    await todosScenario(r);
    expect(menu(r.slots).map((m) => m.group)).toEqual(["Todos", "Todos"]);
    expect(errorLogs(r.logs)).toEqual([]);
    expect(coverageOf(r.context)).toEqual({
      unrendered: [],
      unobserved: [{ slot: "todos:selection", contributions: 1 }],
    });
  });

  it("Contacts alone: the whole Contacts suite", async () => {
    r = await start(contactsHeadless);
    await contactsScenario(r);
    expect(menu(r.slots).map((m) => m.group)).toEqual(["Contacts"]);
    expect(errorLogs(r.logs)).toEqual([]);
    expect(coverageOf(r.context)).toEqual({
      unrendered: [],
      unobserved: [{ slot: "contacts:selection", contributions: 1 }],
    });
  });
});
