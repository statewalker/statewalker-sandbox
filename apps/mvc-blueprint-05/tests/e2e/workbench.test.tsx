/**
 * End-to-end in Chromium: §14 behaviour and interactions (1)–(3) in workbench.react, plus the
 * standalone apps, removal runs, renderer arrival order and `hello`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { contactsUiReactFeature, todosUiReactFeature } from "../../src/features.react.ts";
import { application } from "../../src/kernel/index.ts";
import {
  button,
  clickTodo,
  contactsStandalone,
  hasButton,
  header,
  input,
  menu,
  menuGroups,
  panel,
  type Running,
  rows,
  run,
  tab,
  text,
  toasts,
  todosStandalone,
  typeInto,
  waitFor,
  without,
  withoutBundle,
  workbenchReact,
} from "../support/dom.ts";

let app: Running | undefined;
afterEach(async () => {
  const errors = app?.errors() ?? [];
  await app?.stop();
  app = undefined;
  expect(errors).toEqual([]);
});

const start = async (manifest = workbenchReact, inject: Record<string, unknown> = {}) => {
  app = await run(manifest, inject);
  const h = app.host;
  await waitFor(() => !!panel(h, "todos.list") || !!panel(h, "contacts.list"), "a list panel");
  return h;
};
const openContacts = async (h: HTMLElement) => {
  tab(h, "Contacts");
  await waitFor(() => !!panel(h, "contacts.list"), "contacts tab");
};

describe("todos in workbench.react", () => {
  it("shows the seed, the header count, and adds from the input", async () => {
    const h = await start();
    expect(rows(h)).toEqual(["  Buy milk", "  Write report", "x Call plumber"]);
    expect(header(h)).toEqual(["2 open todos"]);
    expect(button(h, "Add").disabled).toBe(true);
    typeInto(input(h, "New todo title"), "Feed cat");
    await waitFor(() => !button(h, "Add").disabled, "Add enabled");
    button(h, "Add").click();
    await waitFor(() => rows(h).length === 4, "added");
    expect(input(h, "New todo title")?.value).toBe("");
    expect(header(h)).toEqual(["3 open todos"]);
  });

  it("(2) the header follows a checkbox toggle, without any command", async () => {
    const h = await start();
    h.querySelector<HTMLInputElement>('input[aria-label="Done: Buy milk"]')?.click();
    await waitFor(() => header(h)[0] === "1 open todos", "count 1");
  });

  it("selects with click and ctrl-click; Edit needs exactly one; Save updates and closes", async () => {
    const h = await start();
    clickTodo(h, "Buy milk");
    clickTodo(h, "Write report", true);
    await waitFor(() => h.querySelectorAll("li[aria-current]").length === 2, "two selected");
    expect(button(h, "Edit").disabled).toBe(true);
    clickTodo(h, "Write report");
    await waitFor(() => !button(h, "Edit").disabled, "Edit enabled");
    button(h, "Edit").click();
    await waitFor(() => !!panel(h, "todos.edit"), "editor");
    const editor = panel(h, "todos.edit") as HTMLElement;
    expect(input(editor, "Title")?.value).toBe("Write report");
    typeInto(input(editor, "Title"), "Write the report");
    button(editor, "Save").click();
    await waitFor(() => !panel(h, "todos.edit"), "editor closed");
    expect(rows(h)[1]).toBe("  Write the report");
  });

  it("Clear completed asks in a dialog, removes, notifies; focus returns", async () => {
    const h = await start();
    const trigger = button(panel(h, "todos.list") as HTMLElement, "Clear completed");
    trigger.focus();
    trigger.click();
    await waitFor(() => !!h.querySelector("[role=dialog]"), "dialog");
    button(h.querySelector("[role=dialog]") as HTMLElement, "Cancel").click();
    await waitFor(() => document.activeElement === trigger, "focus returned after Cancel");
    trigger.click();
    await waitFor(() => !!h.querySelector("[role=dialog]"), "dialog");
    const dialog = h.querySelector("[role=dialog]") as HTMLElement;
    expect(text(dialog.querySelector("p"))).toBe("Remove 1 completed todo?");
    button(dialog, "Clear").click();
    await waitFor(() => !h.querySelector("[role=dialog]"), "dialog closed");
    await waitFor(() => rows(h).length === 2, "removed");
    expect(toasts(h)).toEqual(["Removed 1 completed todo"]);
    expect(trigger.disabled).toBe(true); // nothing left to clear
  });

  it("menu: New todo… opens the editor in create mode; Save adds", async () => {
    const h = await start();
    menu(h, "New todo…").click();
    await waitFor(() => !!panel(h, "todos.edit"), "editor");
    const editor = panel(h, "todos.edit") as HTMLElement;
    expect(input(editor, "Title")?.value).toBe("");
    typeInto(input(editor, "Title"), "Water plants");
    button(editor, "Save").click();
    await waitFor(() => rows(h).length === 4, "added");
  });
});

describe("rename a todo", () => {
  it("Rename… opens a dialog; Rename updates and withdraws; empty title is refused", async () => {
    const h = await start();
    clickTodo(h, "Buy milk");
    await waitFor(() => !button(h, "Rename…").disabled, "Rename… enabled");
    button(h, "Rename…").click();
    await waitFor(() => !!h.querySelector("[role=dialog]"), "dialog");
    const dialog = h.querySelector("[role=dialog]") as HTMLElement;
    typeInto(input(dialog, "New title"), "");
    button(dialog, "Rename").click();
    await waitFor(() => !!dialog.querySelector("[role=alert]"), "error");
    typeInto(input(dialog, "New title"), "Buy oat milk");
    button(dialog, "Rename").click();
    await waitFor(() => !h.querySelector("[role=dialog]"), "withdrawn");
    await waitFor(() => rows(h)[0] === "  Buy oat milk", "renamed");
  });
});

describe("contacts in workbench.react", () => {
  it("select shows details; Edit opens the seeded editor; Save closes and notifies Saved", async () => {
    const h = await start();
    await openContacts(h);
    expect(menu(h, "Edit contact").disabled).toBe(true);
    button(h, "Alan Turing").click();
    await waitFor(() => !!panel(h, "contacts.details"), "details");
    expect(text(panel(h, "contacts.details")?.querySelector("dd"))).toBe("Alan Turing");
    expect(menu(h, "Edit contact").disabled).toBe(false);
    button(panel(h, "contacts.list") as HTMLElement, "Edit").click();
    await waitFor(() => !!panel(h, "contacts.edit"), "editor");
    const editor = panel(h, "contacts.edit") as HTMLElement;
    expect(input(editor, "Email")?.value).toBe("alan@example.org");
    typeInto(input(editor, "Email"), "alan@turing.org");
    button(editor, "Save").click();
    await waitFor(() => !panel(h, "contacts.edit"), "closed");
    expect(toasts(h)).toEqual(["Saved"]);
  });

  it("an empty name fails with the error on the form and an error toast", async () => {
    const h = await start();
    await openContacts(h);
    button(h, "Grace Hopper").click();
    await waitFor(() => !!panel(h, "contacts.details"), "details");
    menu(h, "Edit contact").click();
    await waitFor(() => !!panel(h, "contacts.edit"), "editor");
    const editor = panel(h, "contacts.edit") as HTMLElement;
    typeInto(input(editor, "Name"), " ");
    button(editor, "Save").click();
    await waitFor(() => !!editor.querySelector("[role=alert]"), "error");
    expect(text(editor.querySelector("[role=alert]"))).toBe("Name is required");
    expect(toasts(h)).toEqual(["Save failed: Name is required"]);
    button(editor, "Cancel").click();
    await waitFor(() => !panel(h, "contacts.edit"), "cancelled");
  });
});

describe("cross-app interactions", () => {
  it("(1) New todo for this contact composes a todo named after the selection", async () => {
    const h = await start();
    await openContacts(h);
    const list = panel(h, "contacts.list") as HTMLElement;
    expect(button(list, "New todo for this contact").disabled).toBe(true);
    button(h, "Ada Lovelace").click();
    await waitFor(() => !button(list, "New todo for this contact").disabled, "enabled");
    button(list, "New todo for this contact").click();
    await waitFor(() => !!panel(h, "todos.edit"), "todo editor");
    const editor = panel(h, "todos.edit") as HTMLElement;
    expect(input(editor, "Title")?.value).toBe("Ada Lovelace");
    button(editor, "Save").click();
    await waitFor(() => header(h)[0] === "3 open todos", "count 3");
    tab(h, "Todos");
    await waitFor(() => rows(h).includes("  Ada Lovelace"), "listed");
  });

  it("(3) one main menu with every app's group", async () => {
    const h = await start();
    expect(menuGroups(h)).toEqual(["Contacts", "Hello", "Todos"]);
  });
});

describe("removal and standalone", () => {
  it("without Contacts: only its group and tab go; Todos works", async () => {
    const h = await start(
      without(workbenchReact, "contacts", "contacts.ui.react", "todos-contacts"),
    );
    expect(menuGroups(h)).toEqual(["Hello", "Todos"]);
    expect(hasButton(h, "Contacts")).toBe(false);
    typeInto(input(h, "New todo title"), "Solo");
    button(h, "Add").click();
    await waitFor(() => rows(h).length === 4, "added");
  });

  it("without Todos: Contacts works, no New todo action", async () => {
    const h = await start(without(workbenchReact, "todos", "todos.ui.react", "todos-contacts"));
    expect(menuGroups(h)).toEqual(["Contacts", "Hello"]);
    button(h, "Ada Lovelace").click();
    await waitFor(() => !!panel(h, "contacts.details"), "details");
    expect(hasButton(h, "New todo for this contact")).toBe(false);
    expect(header(h)).toEqual([]);
  });

  it("without todos-contacts and without todos.status: the action and the header item are gone", async () => {
    const h = await start(withoutBundle(without(workbenchReact, "todos-contacts"), "todos.status"));
    expect(header(h)).toEqual([]);
    await openContacts(h);
    expect(hasButton(h, "New todo for this contact")).toBe(false);
    expect(hasButton(panel(h, "contacts.list") as HTMLElement, "Edit")).toBe(true);
  });

  it("todos.standalone and contacts.standalone run alone", async () => {
    let h = await start(todosStandalone);
    expect(menuGroups(h)).toEqual(["Todos"]);
    expect(rows(h)).toHaveLength(3);
    await app?.stop();
    h = await start(contactsStandalone);
    expect(menuGroups(h)).toEqual(["Contacts"]);
    expect(hasButton(h, "Ada Lovelace")).toBe(true);
  });
});

describe("arrival order", () => {
  it("model before renderer: listed in coverage, rendered when the renderer arrives", async () => {
    const noUi = without(workbenchReact, "todos.ui.react", "contacts.ui.react");
    app = await run(noUi);
    const h = app.host;
    await waitFor(() => !!h.querySelector("[data-missing-renderer='todos:list']"), "gap shown");
    expect(h.querySelector("[data-coverage]")?.textContent).toContain("todos.list (todos:list)");
    const stopUi = await application({
      id: "ui",
      features: [todosUiReactFeature, contactsUiReactFeature],
    })(app.context);
    await waitFor(() => rows(h).length === 3, "rendered");
    expect(h.querySelector("[data-coverage]")?.textContent).not.toContain(
      "todos.list (todos:list)",
    );
    await stopUi?.();
    await waitFor(() => !!h.querySelector("[data-missing-renderer='todos:list']"), "gap again");
  });

  it("renderer before model: nothing to show, then the panel appears", async () => {
    const logicLast = {
      ...workbenchReact,
      features: [
        ...workbenchReact.features.filter(
          (f) => f.id.includes("ui.react") || f.id.startsWith("shell"),
        ),
      ],
    };
    app = await run(logicLast);
    const h = app.host;
    expect(panel(h, "todos.list")).toBeNull();
    const { todosFeature } = await import("../../src/features.ts");
    const stopTodos = await application({
      id: "late",
      features: [{ id: "shell", bundles: [] }, todosFeature],
    })(app.context);
    await waitFor(() => rows(h).length === 3, "rendered");
    await stopTodos?.();
    await waitFor(() => !panel(h, "todos.list"), "withdrawn");
  });
});

describe("hello", () => {
  it("menu item opens the panel; the action increments", async () => {
    const h = await start();
    menu(h, "Say hello").click();
    await waitFor(() => hasButton(h, "Hello"), "tab");
    tab(h, "Hello");
    await waitFor(() => hasButton(h, "Increment"), "panel");
    button(h, "Increment").click();
    button(h, "Increment").click();
    await waitFor(() => text(h.querySelector("output")) === "2", "count 2");
  });
});
