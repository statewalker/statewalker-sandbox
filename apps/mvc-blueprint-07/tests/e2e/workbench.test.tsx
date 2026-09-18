import { afterEach, describe, expect, it } from "vitest";
import {
  contactsStandalone,
  todosStandalone,
  without,
  workbenchReact,
} from "../../src/apps/manifests.js";
import { setContactApi } from "../../src/bundles/contacts/api/index.js";
import { createMemContactApi } from "../../src/bundles/contacts.core/mem-api.js";
import { setTodoApi } from "../../src/bundles/todos/api/index.js";
import { createMemTodoApi } from "../../src/bundles/todos.core/mem-api.js";
import {
  all,
  button,
  click,
  flush,
  input,
  mount,
  text,
  typeInto,
  waitFor,
} from "../support/dom.js";

type App = Awaited<ReturnType<typeof mount>>;
let app: App | undefined;
const cur = (): App => {
  if (!app) throw new Error("no app mounted");
  return app;
};
afterEach(async () => {
  await app?.unmount();
  app = undefined;
});

const header = (a: App) => text(a.host.querySelector("header"));
const menuGroups = (a: App) => all(a.host, ".menu legend").map((l) => text(l));
const todoTitles = (a: App) => all(a.host, 'ul[aria-label="Todos"] li').map((li) => text(li));
const side = (a: App, title: string) =>
  a.host.querySelector<HTMLElement>(`aside section[aria-label="${title}"]`);
const tab = async (a: App, name: string) => {
  await click(a.host.querySelector('[role="tablist"]') as HTMLElement, name);
};
const toasts = (a: App) =>
  all(a.host, '.toasts [role="status"]').map((t) => text(t.querySelector("span")));
const row = (a: App, title: string) =>
  all(a.host, 'ul[aria-label="Todos"] li').find((li) => text(li) === title) as HTMLElement;

describe("§14 behaviour in the React workbench", () => {
  it("interactions (2) and (3): the header counts open todos; both apps' menu groups appear", async () => {
    app = await mount(workbenchReact);
    await waitFor(() => header(cur()).includes("2 open todos"), "the count");
    expect(menuGroups(app)).toEqual(["Todos", "Contacts", "Hello"]);
    // toggling, adding and clearing update the count with no command
    (row(app, "Buy milk").querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await waitFor(() => header(cur()).includes("1 open todos"), "count after toggle");
    typeInto(input(app.host, "New todo title"), "Water plants");
    await click(app.host, "Add");
    await waitFor(() => header(cur()).includes("2 open todos"), "count after add");
    expect(todoTitles(app)).toContain("Water plants");
    const menu = app.host.querySelector('fieldset[aria-label="Todos"]') as HTMLElement;
    await click(menu, "Clear completed");
    const dialog = () => cur().host.querySelector('[role="dialog"]');
    await waitFor(() => dialog() !== null, "the confirm dialog");
    expect(text(dialog())).toContain("Remove 2 completed todos?");
    await click(dialog() as HTMLElement, "Clear");
    await waitFor(() => dialog() === null, "dialog withdrawn");
    await waitFor(() => toasts(cur()).includes("Removed 2 completed todos"), "notification");
    expect(todoTitles(app)).toEqual(["Write report", "Water plants"]);
    expect(header(app)).toContain("2 open todos");
  });

  it("select, Edit, keep typing after Save: the saved title is the one at submit", async () => {
    app = await mount(workbenchReact, (c) => setTodoApi(c, createMemTodoApi({ delay: 30 })));
    await waitFor(() => todoTitles(cur()).length === 3, "todos");
    await click(row(app, "Write report"), "Write report");
    expect(row(app, "Write report").getAttribute("aria-current")).toBe("true");
    await click(app.host.querySelector('[aria-label="Selection actions"]') as HTMLElement, "Edit");
    await waitFor(() => side(cur(), "Edit “Write report”") !== null, "editor");
    const editor = side(app, "Edit “Write report”") as HTMLElement;
    typeInto(input(editor, "Title"), "Write the report");
    await click(editor, "Save");
    expect(button(editor, "Save")?.disabled).toBe(true); // visibly running
    typeInto(input(editor, "Title"), "typed after save");
    await waitFor(() => side(cur(), "Edit “Write report”") === null, "editor closes on success");
    expect(todoTitles(app)).toContain("Write the report");
  });

  it("New todo… from the menu; an empty title fails with the error on the form", async () => {
    app = await mount(workbenchReact);
    await click(app.host.querySelector('fieldset[aria-label="Todos"]') as HTMLElement, "New todo…");
    await waitFor(() => side(cur(), "New todo") !== null, "create editor");
    const editor = side(app, "New todo") as HTMLElement;
    await click(editor, "Add");
    await waitFor(
      () => text(editor.querySelector('[role="alert"]')) === "Title is required",
      "form error",
    );
    typeInto(input(editor, "Title"), "Plan trip");
    await click(editor, "Add");
    await waitFor(() => todoTitles(cur()).includes("Plan trip"), "added");
    expect(side(app, "New todo")).toBeNull();
  });

  it("Contacts: details on select; Edit; empty name fails; fixing it saves and notifies", async () => {
    app = await mount(workbenchReact);
    await tab(app, "Contacts");
    await click(app.host, "Ada Lovelace");
    await waitFor(() => side(cur(), "Contact") !== null, "details");
    expect(text(side(app, "Contact"))).toContain("ada@example.org");
    await click(app.host.querySelector('[aria-label="Contact actions"]') as HTMLElement, "Edit");
    await waitFor(() => side(cur(), "Edit Ada Lovelace") !== null, "contact editor");
    const editor = side(app, "Edit Ada Lovelace") as HTMLElement;
    typeInto(input(editor, "Name"), " ");
    await click(editor, "Save");
    await waitFor(
      () => text(editor.querySelector('[role="alert"]')) === "Name must not be empty",
      "error",
    );
    expect(toasts(app)).toContain("Could not save: Name must not be empty");
    typeInto(input(editor, "Name"), "Ada King");
    await click(editor, "Save");
    await waitFor(() => side(cur(), "Edit Ada Lovelace") === null, "editor closed");
    expect(toasts(app)).toContain("Saved");
    expect(text(side(app, "Contact"))).toContain("Ada King");
    // the menu item follows the selection too
    const menu = app.host.querySelector('fieldset[aria-label="Contacts"]') as HTMLElement;
    expect(button(menu, "Edit contact")?.disabled).toBe(false);
  });

  it("interaction (1): New todo for this contact prefills the Todos editor; Save adds it", async () => {
    app = await mount(workbenchReact);
    await waitFor(() => header(cur()).includes("2 open todos"), "count");
    await tab(app, "Contacts");
    const actions = () => cur().host.querySelector('[aria-label="Contact actions"]') as HTMLElement;
    expect(button(actions(), "New todo for this contact")?.disabled).toBe(true);
    await click(app.host, "Grace Hopper");
    await click(actions(), "New todo for this contact");
    await waitFor(() => side(cur(), "New todo") !== null, "create editor");
    expect(input(side(app, "New todo") as HTMLElement, "Title")?.value).toBe("Grace Hopper");
    await click(side(app, "New todo") as HTMLElement, "Add");
    await waitFor(() => header(cur()).includes("3 open todos"), "count +1");
  });

  it("dismissing a notification withdraws it", async () => {
    app = await mount(workbenchReact);
    await tab(app, "Contacts");
    await click(app.host, "Alan Turing");
    await click(app.host.querySelector('[aria-label="Contact actions"]') as HTMLElement, "Edit");
    await waitFor(() => side(cur(), "Edit Alan Turing") !== null, "editor");
    await click(side(app, "Edit Alan Turing") as HTMLElement, "Save");
    await waitFor(() => toasts(cur()).includes("Saved"), "toast");
    await click(app.host.querySelector(".toasts") as HTMLElement, "Dismiss");
    await waitFor(() => toasts(cur()).length === 0, "toast gone");
  });

  it("hello: the minimal bundle's menu item and panel increment one counter", async () => {
    app = await mount(workbenchReact);
    await click(app.host.querySelector('fieldset[aria-label="Hello"]') as HTMLElement, "Increment");
    await tab(app, "Hello");
    await waitFor(() => text(cur().host.querySelector("output")) === "1", "count 1");
    await click(app.host.querySelector('[role="tabpanel"]') as HTMLElement, "Increment");
    await waitFor(() => text(cur().host.querySelector("output")) === "2", "count 2");
  });
});

describe("standalone and removal in the browser", () => {
  it("Todos standalone: its own menu group only, fully working", async () => {
    app = await mount(todosStandalone);
    await waitFor(() => header(cur()).includes("2 open todos"), "count");
    expect(menuGroups(app)).toEqual(["Todos"]);
    expect(app.host.querySelectorAll('[role="tab"]').length).toBe(1);
  });
  it("Contacts standalone: no header count, Contacts group only", async () => {
    app = await mount(contactsStandalone, (c) => setContactApi(c, createMemContactApi()));
    await waitFor(() => all(cur().host, 'ul[aria-label="Contacts"] li').length === 3, "contacts");
    expect(menuGroups(app)).toEqual(["Contacts"]);
    expect(header(app)).toBe("Workbench");
  });
  it("workbench without the Contacts feature: its group and tab are gone, nothing else", async () => {
    app = await mount(without(workbenchReact, ["contacts", "contacts.react", "todos-contacts"]));
    await waitFor(() => header(cur()).includes("2 open todos"), "count");
    expect(menuGroups(app)).toEqual(["Todos", "Hello"]);
    expect(all(app.host, '[role="tab"]').map((t) => text(t))).toEqual(["Todos", "Hello"]);
    expect(app.errors()).toEqual([]);
  });
  it("stopping the application unmounts the host and leaves nothing behind", async () => {
    const a = await mount(workbenchReact);
    await a.stop();
    await flush();
    expect(a.host.innerHTML).toBe("");
    expect(a.log.stats().openScopes).toEqual([]);
    a.host.remove();
  });
});

describe("Rename a todo (§14.6)", () => {
  it("Rename… opens a dialog; Rename updates the title and withdraws it", async () => {
    app = await mount(workbenchReact);
    await waitFor(() => todoTitles(cur()).length === 3, "todos");
    await click(row(app, "Buy milk"), "Buy milk");
    await click(
      app.host.querySelector('[aria-label="Selection actions"]') as HTMLElement,
      "Rename…",
    );
    const d = () => cur().host.querySelector('[role="dialog"]') as HTMLElement | null;
    await waitFor(() => d() !== null, "rename dialog");
    typeInto(input(d() as HTMLElement, "New title"), "Buy oat milk");
    await click(d() as HTMLElement, "Rename");
    await waitFor(() => d() === null, "dialog withdrawn");
    expect(todoTitles(app)).toContain("Buy oat milk");
  });
});
