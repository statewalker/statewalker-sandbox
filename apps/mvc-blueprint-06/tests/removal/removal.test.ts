/**
 * Removal: the workbench without a feature (start-time), and a feature stopped at runtime. The
 * coverage report here is headless: which points still hold contributions, and dead letters.
 */
import { describe, expect, it } from "vitest";
import { workbenchHeadless } from "../../src/apps/index.js";
import { contactsFeature } from "../../src/features.js";
import { NoSuchActor, without } from "../../src/kernel/index.js";
import {
  contactsBasics,
  headerCount,
  newTodoForContact,
  todosBasics,
  todosEditorFailureAndCancel,
} from "../scenario/scenario.js";
import { type Harness, start } from "../support/headless.js";

const report = (name: string, dropped: string[], h: Harness) => ({
  removed: name,
  dropped,
  actors: h.system.addresses(),
  panels: h.panelIds(),
  menuGroups: h.menuGroups(),
  header: h.headerTexts(),
  deadLetters: h.system.deadLetters.length,
  errors: h.errors().length,
});

const scenarios = {
  todos: [todosBasics, todosEditorFailureAndCancel],
  status: [headerCount],
  contacts: [contactsBasics],
  link: [newTodoForContact],
};

const cases: [string, (keyof typeof scenarios)[]][] = [
  ["todos-contacts", ["todos", "status", "contacts"]],
  ["todos.status", ["todos", "contacts", "link"]],
  ["contacts", ["todos", "status"]],
  ["todos", ["contacts"]],
];

describe("removal at start", () => {
  for (const [feature, remaining] of cases) {
    it(`without ${feature}: the remaining scenarios pass, nothing at error level`, async () => {
      const reports: unknown[] = [];
      for (const key of remaining) {
        for (const run of scenarios[key]) {
          const { manifest, dropped } = without(
            workbenchHeadless({ notifyTimeoutMs: 60_000 }),
            feature,
          );
          const h = await start(manifest);
          await run(h);
          expect(h.errors()).toEqual([]);
          reports.push(report(feature, dropped, h));
          await h.stop();
        }
      }
      console.log(JSON.stringify(reports[0]));
    });
  }

  it("without todos.status the header is empty and nothing else changes", async () => {
    const h = await start(without(workbenchHeadless(), "todos.status").manifest);
    expect(h.headerTexts()).toEqual([]);
    expect(h.menuGroups()).toEqual(["Todos", "Contacts"]);
    await h.stop();
  });
});

describe("removal at runtime", () => {
  it("stopping Contacts withdraws its panels, menu group and the link's action; messages to it are dead letters", async () => {
    const h = await start(workbenchHeadless({ notifyTimeoutMs: 60_000 }));
    await contactsBasics(h);
    const ids = [...contactsFeature().bundles.map((b) => b.id), "todos.contacts-link"].reverse();
    for (const id of ids) h.system.stop(id);
    expect(h.menuGroups()).toEqual(["Todos"]);
    expect(h.panelIds().filter((p) => p.startsWith("contacts"))).toEqual([]);
    // What happens to a message sent to a removed bundle: a tell is a dead letter; an ask rejects.
    h.system.send("contacts.edit", { type: "save" });
    expect(h.system.deadLetters.at(-1)).toMatchObject({ to: "contacts.edit" });
    await expect(
      h.system.ask("contacts.edit", { type: "contacts:edit:open", id: "c1" }),
    ).rejects.toBeInstanceOf(NoSuchActor);
    // Todos is untouched.
    await headerCount(h);
    expect(h.errors()).toEqual([]);
    await h.stop();
  });
});
