import { describe, expect, it } from "vitest";
import {
  contactsStandalone,
  headless,
  todosStandalone,
  without,
  workbenchReact,
} from "../../src/apps/manifests.js";
import { menuSlot } from "../../src/bundles/shell/api/index.js";
import { coverageReport } from "../../src/bundles/shell.react/coverage.js";
import { contactsReact, helloReact, todosContacts, todosReact } from "../../src/features.js";
import type { ApplicationManifest, FeatureManifest } from "../../src/kernel/loader.js";
import { type Probe, start } from "../support/headless.js";
import {
  contactAction,
  contactEditor,
  contactList,
  openTodoEditor,
  titles,
} from "../support/todos.js";

/** Renderer bundles without the host: headless, but the coverage report sees the renderers. */
const withRenderers = (app: ApplicationManifest): ApplicationManifest => {
  const present = new Set(app.features.map((f) => f.id));
  const ui = [todosReact, contactsReact, helloReact]
    .filter((f) => present.has(f.id))
    .map((f): FeatureManifest => ({ ...f, requires: [] }));
  return { id: app.id, features: [...headless(app).features, ...ui] };
};
const groups = (app: Probe) => [
  ...new Set(app.slots.getSnapshot(menuSlot).map((m) => m.groupLabel)),
];

async function todosScenario(app: Probe) {
  const form = openTodoEditor(app, "t1");
  form.editTitle("Buy oat milk");
  form.save.submit();
  await app.log.idle();
  expect(titles(app)[0]).toBe("Buy oat milk");
}
async function contactsScenario(app: Probe) {
  contactList(app).select("c1");
  contactAction(app, "Edit").submit();
  contactEditor(app, "c1")?.editField("phone", "000");
  contactEditor(app, "c1")?.save.submit();
  await app.log.idle();
  expect(app.toasts().map((t) => t.message)).toContain("Saved");
}

describe("standalone runs (§14.5)", () => {
  it("Todos runs alone: its scenario passes, one menu group, nothing logged at error", async () => {
    const app = await start(withRenderers(todosStandalone));
    await todosScenario(app);
    expect(groups(app)).toEqual(["Todos"]);
    expect(coverageReport(app.slots)).toEqual([]);
    expect(app.errors()).toEqual([]);
    await app.stop();
  });
  it("Contacts runs alone likewise", async () => {
    const app = await start(withRenderers(contactsStandalone));
    await contactsScenario(app);
    expect(groups(app)).toEqual(["Contacts"]);
    expect(coverageReport(app.slots)).toEqual([]);
    expect(app.errors()).toEqual([]);
    await app.stop();
  });
});

describe("removal runs (§13.3)", () => {
  const cases: Array<[string, string[], (app: Probe) => Promise<void>]> = [
    [
      "todos-contacts",
      ["todos-contacts"],
      async (app) => {
        await todosScenario(app);
        await contactsScenario(app);
        contactList(app).select("c1");
        expect(
          contactList(app)
            .getActions()
            .map((a) => a.action.getState().label),
        ).toEqual(["Edit"]);
      },
    ],
    [
      "todos.status",
      ["todos.status"],
      async (app) => {
        await todosScenario(app);
        expect(app.header()).toEqual([]);
      },
    ],
    [
      "the Contacts feature",
      ["contacts", "contacts.react", todosContacts.id],
      async (app) => {
        await todosScenario(app);
        expect(groups(app)).toEqual(["Todos", "Hello"]);
      },
    ],
    [
      "the Todos feature",
      ["todos", "todos.react", todosContacts.id],
      async (app) => {
        await contactsScenario(app);
        expect(groups(app)).toEqual(["Contacts", "Hello"]);
        expect(app.header()).toEqual([]);
      },
    ],
  ];
  for (const [name, ids, scenario] of cases) {
    it(`without ${name}: the rest passes, no error logged, coverage report is the only trace`, async () => {
      const app = await start(withRenderers(without(workbenchReact, ids)));
      await scenario(app);
      expect(app.errors()).toEqual([]);
      expect(coverageReport(app.slots)).toEqual([]);
      await app.stop();
    });
  }

  it("without the UI bundle of a feature, its panels are listed in the coverage report", async () => {
    const app = await start(withRenderers(without(workbenchReact, ["contacts.react"])));
    expect(coverageReport(app.slots)).toEqual([
      { slot: "shell:panels", id: "contacts:list", kind: "contacts:list" },
    ]);
    await app.stop();
  });

  it("a link whose answerer is missing fails loudly (required intent, no handler)", async () => {
    // bypass the feature requirement on purpose: the link without Todos
    const broken = without(workbenchReact, ["todos", "todos.react"]);
    const app = await start(
      headless({
        ...broken,
        features: broken.features.map((f) =>
          f.id === "todos-contacts" ? { ...f, requires: [] } : f,
        ),
      }),
    );
    contactList(app).select("c1");
    contactAction(app, "New todo for this contact").submit();
    await app.log.idle();
    expect(app.errors().map((e) => e.message)).toEqual([
      "no handler for required intent todos:compose (from todos.contacts-link)",
    ]);
    await app.stop();
  });
});
