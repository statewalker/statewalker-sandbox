/** §14 behaviour and interactions (1)–(3), through the React UI only. */
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { contactsStandalone, todosStandalone, workbenchReact } from "../../src/apps/react.js";
import { coverage } from "../../src/bundles/shell.react/index.js";
import { logicFeatures, shellFeature, todosFeature } from "../../src/features.js";
import {
  contactsUiReactFeature,
  shellReactFeature,
  todosUiReactFeature,
} from "../../src/features.react.js";
import { application, without } from "../../src/kernel/index.js";
import { button, type RunningApp, run, typeInto, ui, waitFor } from "../support/react.js";

const opts = { notifyTimeoutMs: 60_000 };

describe("workbench.react · e2e", () => {
  let app: RunningApp | undefined;
  afterEach(async () => {
    if (!app) return;
    expect(app.errors()).toEqual([]);
    await app.stop();
    app = undefined;
  });

  it("Todos: add, toggle, select + delete, edit + save, clear completed", async () => {
    app = await run((root) => workbenchReact(root, opts));
    const u = ui(app.root);
    await waitFor(() => u.titles().length === 3);

    typeInto(app.root.querySelector('input[aria-label="New todo"]'), "Call mum");
    await waitFor(() => button(app?.root as HTMLElement, "Add")?.disabled === false);
    button(app.root, "Add")?.click();
    await waitFor(() => u.titles().includes("Call mum"));
    expect((app.root.querySelector('input[aria-label="New todo"]') as HTMLInputElement).value).toBe(
      "",
    );

    (app.root.querySelector('input[aria-label="Done: Buy milk"]') as HTMLInputElement).click();
    await waitFor(() => u.row("Buy milk")?.querySelector("span")?.className === "done");

    u.row("Call mum")?.click();
    await waitFor(() => u.row("Call mum")?.getAttribute("aria-current") === "true");
    button(app.root, "Delete")?.click();
    await waitFor(() => !u.titles().includes("Call mum"));

    u.row("Write report")?.click();
    await waitFor(() => button(app?.root as HTMLElement, "Edit")?.disabled === false);
    button(app.root, "Edit")?.click();
    await waitFor(() => u.panel("todos:editor") !== null);
    typeInto(
      u.panel("todos:editor")?.querySelector('input[aria-label="Title"]'),
      "Write the report",
    );
    button(u.panel("todos:editor") as HTMLElement, "Save")?.click();
    await waitFor(() => u.panel("todos:editor") === null);
    await waitFor(() => u.titles().includes("Write the report"));
    await waitFor(() => u.toasts().includes("Saved"));

    button(app.root, "Clear completed")?.click();
    await waitFor(() => u.dialog() !== null);
    expect(u.dialog()?.textContent).toContain("Delete 2 completed todos?");
    button(u.dialog() as HTMLElement, "Clear")?.click();
    await waitFor(() => u.dialog() === null);
    expect(u.titles()).toEqual(["Write the report"]);
    await waitFor(() => u.toasts().includes("Cleared 2 completed todos"));
  });

  it("Contacts: select shows details; edit fails on an empty name, then saves; cancel withdraws", async () => {
    app = await run((root) => workbenchReact(root, opts));
    const u = ui(app.root);
    await waitFor(() => u.tab("Contacts") !== undefined);
    u.tab("Contacts")?.click();
    await waitFor(() => u.contact("Alan Turing") !== undefined);
    expect(u.menuItem("Edit contact")?.disabled).toBe(true);
    u.contact("Alan Turing")?.click();
    await waitFor(() => u.panel("contacts:details") !== null);
    expect(u.menuItem("Edit contact")?.disabled).toBe(false);
    button(u.panel("contacts:details") as HTMLElement, "Edit")?.click();
    await waitFor(() => u.panel("contacts:editor") !== null);
    const editor = () => u.panel("contacts:editor") as HTMLElement;
    expect((editor().querySelector('input[aria-label="Name"]') as HTMLInputElement).value).toBe(
      "Alan Turing",
    );
    typeInto(editor().querySelector('input[aria-label="Name"]'), " ");
    button(editor(), "Save")?.click();
    await waitFor(() => editor().querySelector("[data-error]") !== null);
    expect(editor().querySelector("[data-error]")?.textContent).toBe("Name is required");
    await waitFor(() => app?.root.querySelector('[data-notification] [role="alert"]') !== null);
    typeInto(editor().querySelector('input[aria-label="Name"]'), "Alan M. Turing");
    button(editor(), "Save")?.click();
    await waitFor(() => u.panel("contacts:editor") === null);
    await waitFor(
      () =>
        u.panel("contacts:details")?.querySelector('[data-field="name"]')?.textContent ===
        "Alan M. Turing",
    );
    u.menuItem("Edit contact")?.click();
    await waitFor(() => u.panel("contacts:editor") !== null);
    button(editor(), "Cancel")?.click();
    await waitFor(() => u.panel("contacts:editor") === null);
  });

  it("(1) New todo for this contact — prefilled editor, Save adds the todo", async () => {
    app = await run((root) => workbenchReact(root, opts));
    const u = ui(app.root);
    await waitFor(() => u.tab("Contacts") !== undefined);
    u.tab("Contacts")?.click();
    await waitFor(() => u.contact("Grace Hopper") !== undefined);
    u.contact("Grace Hopper")?.click();
    await waitFor(
      () => button(app?.root as HTMLElement, "New todo for this contact") !== undefined,
    );
    button(app.root, "New todo for this contact")?.click();
    await waitFor(() => u.panel("todos:editor") !== null);
    expect(
      (u.panel("todos:editor")?.querySelector('input[aria-label="Title"]') as HTMLInputElement)
        .value,
    ).toBe("Grace Hopper");
    button(u.panel("todos:editor") as HTMLElement, "Save")?.click();
    await waitFor(() => u.panel("todos:editor") === null);
    u.tab("Todos")?.click();
    await waitFor(() => u.titles().includes("Grace Hopper"));
  });

  it("(2) the header count follows toggles, adds and clears — no command", async () => {
    app = await run((root) => workbenchReact(root, opts));
    const u = ui(app.root);
    await waitFor(() => u.header().includes("2 open todos"));
    (app.root.querySelector('input[aria-label="Done: Buy milk"]') as HTMLInputElement).click();
    await waitFor(() => u.header().includes("1 open todos"));
    typeInto(app.root.querySelector('input[aria-label="New todo"]'), "More");
    button(app.root, "Add")?.click();
    await waitFor(() => u.header().includes("2 open todos"));
    button(app.root, "Clear completed")?.click();
    await waitFor(() => u.dialog() !== null);
    button(u.dialog() as HTMLElement, "Clear")?.click();
    await waitFor(() => u.dialog() === null);
    expect(u.header()).toContain("2 open todos");
  });

  it("(3) both groups in one main menu; the menu items work", async () => {
    app = await run((root) => workbenchReact(root, opts));
    const u = ui(app.root);
    await waitFor(() => u.menuGroups().length === 2);
    expect(u.menuGroups()).toEqual(["Todos", "Contacts"]);
    u.menuItem("New todo…")?.click();
    await waitFor(() => u.panel("todos:editor") !== null);
  });

  it("typing into a controlled input: one message per keystroke keeps the caret (real keyboard)", async () => {
    app = await run((root) => workbenchReact(root, opts));
    const input = () => app?.root.querySelector('input[aria-label="New todo"]') as HTMLInputElement;
    await waitFor(() => input() !== null);
    const before = app.system.stats().delivered;
    await userEvent.click(input());
    await userEvent.keyboard("abcd");
    expect(input().value).toBe("abcd");
    input().setSelectionRange(1, 1);
    await userEvent.keyboard("X");
    expect(input().value).toBe("aXbcd");
    expect(input().selectionStart).toBe(2);
    // One message to todos.list per keystroke (and the Add action's enabled flip).
    const perKeystroke = (app.system.stats().delivered - before) / 5;
    console.log(JSON.stringify({ browserMessagesPerKeystroke: perKeystroke }));
    expect(perKeystroke).toBeLessThan(2);
  });

  it("a dialog returns focus on withdrawal", async () => {
    app = await run((root) => workbenchReact(root, opts));
    const u = ui(app.root);
    // The toolbar button (the menu's same-named item sits in a closed <details> and cannot take focus).
    const toolbarButton = () =>
      app?.root.querySelector<HTMLButtonElement>(
        '[role="toolbar"] [data-action="clear-completed"]',
      );
    await waitFor(() => toolbarButton()?.disabled === false);
    const opener = toolbarButton() as HTMLButtonElement;
    opener.focus();
    opener.click();
    await waitFor(() => u.dialog() !== null);
    expect(document.activeElement).toBe(u.dialog());
    button(u.dialog() as HTMLElement, "Cancel")?.click();
    await waitFor(() => u.dialog() === null);
    expect(document.activeElement).toBe(opener);
  });
});

describe("standalone React apps", () => {
  it("todos.standalone: Todos only", async () => {
    const app = await run((root) => todosStandalone(root, opts));
    const u = ui(app.root);
    await waitFor(() => u.titles().length === 3);
    expect(u.menuGroups()).toEqual(["Todos"]);
    expect(u.header()).toEqual(["2 open todos"]);
    expect(app.errors()).toEqual([]);
    await app.stop();
  });
  it("contacts.standalone: Contacts only, no link action", async () => {
    const app = await run((root) => contactsStandalone(root, opts));
    const u = ui(app.root);
    await waitFor(() => u.contact("Ada Lovelace") !== undefined);
    u.contact("Ada Lovelace")?.click();
    await waitFor(() => u.panel("contacts:details") !== null);
    expect(button(app.root, "New todo for this contact")).toBeUndefined();
    expect(u.menuGroups()).toEqual(["Contacts"]);
    expect(app.errors()).toEqual([]);
    await app.stop();
  });
});

describe("arrival order and coverage", () => {
  it("model before renderer: the panel renders when its UI bundle arrives; a missing one is in the coverage report", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = await run(() => ({
      id: "no-todos-ui",
      features: [...logicFeatures(opts), shellReactFeature(root), contactsUiReactFeature],
    }));
    const u = ui(root);
    await waitFor(() => root.querySelector('[data-unrendered="todos:list"]') !== null);
    const report = app.system.streams.get(coverage);
    expect(report?.unrendered).toEqual([
      { point: "shell:panels", id: "todos:list", kind: "todos:list" },
    ]);
    console.log(JSON.stringify({ coverage: report }));
    const stopUi = await application({
      id: "late-ui",
      features: [{ ...todosUiReactFeature, requires: [] }],
    })(app.system);
    await waitFor(() => u.titles().length === 3);
    expect(app.system.streams.get(coverage)?.unrendered).toEqual([]);
    await stopUi();
    root.remove();
    await app.stop();
  });

  it("renderer before model: the host renders the model when its logic bundle arrives", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = await run(() => ({
      id: "ui-first",
      features: [shellFeature, shellReactFeature(root), { ...todosUiReactFeature, requires: [] }],
    }));
    const u = ui(root);
    await new Promise((r) => setTimeout(r, 20));
    expect(u.titles()).toEqual([]);
    const stopLogic = await application({
      id: "logic-later",
      features: [{ ...todosFeature(opts), requires: [] }],
    })(app.system);
    await waitFor(() => u.titles().length === 3);
    await stopLogic();
    await waitFor(() => u.titles().length === 0);
    root.remove();
    await app.stop();
  });
});

describe("removal (React)", () => {
  for (const feature of ["todos-contacts", "todos.status", "contacts", "todos"]) {
    it(`without ${feature}: no error, the coverage report is empty, the rest renders`, async () => {
      const app = await run((root) => without(workbenchReact(root, opts), feature).manifest);
      const u = ui(app.root);
      await waitFor(() => u.menuGroups().length > 0);
      if (feature !== "todos") await waitFor(() => u.titles().length === 3);
      if (feature === "todos") await waitFor(() => u.contact("Ada Lovelace") !== undefined);
      expect(app.system.streams.get(coverage)?.unrendered).toEqual([]);
      console.log(
        JSON.stringify({
          removed: feature,
          menu: u.menuGroups(),
          header: u.header(),
          coverage: app.system.streams.get(coverage),
        }),
      );
      expect(app.errors()).toEqual([]);
      await app.stop();
    });
  }
});
