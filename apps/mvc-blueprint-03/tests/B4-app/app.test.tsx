import { afterEach, describe, expect, it } from "vitest";
import { type RunningApp, startApp } from "../../src/app.js";
import { ScriptedTodoApi } from "../support/api.js";
import { all, button, createHost, typeInto, waitFor } from "../support/react.js";

const seed = [
  { id: "t1", title: "Buy milk", done: false },
  { id: "t2", title: "Walk dog", done: true },
];

describe("B4 · the running app", () => {
  let app: RunningApp | undefined;
  let root: HTMLElement | undefined;

  afterEach(async () => {
    await app?.dispose();
    root?.remove();
    app = undefined;
    root = undefined;
  });

  const scope = () => root as HTMLElement;
  const titles = () => all(scope(), "[data-todo] span").map((s) => s.textContent);
  const row = (title: string) =>
    all(scope(), "[data-todo]").find((li) => li.textContent?.includes(title));
  const editPanel = () => scope().querySelector('[data-panel="todos:edit"]');
  const toasts = (role: "status" | "alert") =>
    all(scope(), `[data-notification] [role="${role}"]`).map((t) => t.textContent ?? "");

  it("add, toggle, context-menu delete, edit and save, clear completed — through the UI only", async () => {
    root = createHost();
    const unrendered: unknown[] = [];
    app = startApp(root, {
      api: new ScriptedTodoApi(seed),
      notificationTimeoutMs: 60_000,
      onUnrendered: (u) => unrendered.push(u),
    });
    await waitFor(() => titles().length === 2);

    typeInto(scope().querySelector('input[aria-label="New todo"]'), "Call mum");
    await waitFor(() => button(scope(), "Add")?.disabled === false);
    button(scope(), "Add")?.click();
    await waitFor(() => titles().includes("Call mum"));
    expect((scope().querySelector('input[aria-label="New todo"]') as HTMLInputElement).value).toBe(
      "",
    );

    (scope().querySelector('input[aria-label="Done: Buy milk"]') as HTMLInputElement).click();
    await waitFor(
      () => row("Buy milk")?.querySelector("span")?.className.includes("line-through") === true,
    );

    row("Call mum")?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    await waitFor(() => scope().querySelector('[role="menu"]') !== null);
    all<HTMLButtonElement>(scope(), '[role="menuitem"]')
      .find((b) => b.textContent === "Delete")
      ?.click();
    await waitFor(() => !titles().includes("Call mum"));

    button(scope(), 'Edit "Walk dog"')?.click();
    await waitFor(() => editPanel() !== null);
    typeInto(editPanel()?.querySelector('input[aria-label="Title"]'), "Walk the dog");
    await waitFor(() => button(editPanel() as Element, "Save")?.disabled === false);
    button(editPanel() as Element, "Save")?.click();
    await waitFor(() => editPanel() === null);
    await waitFor(() => titles().includes("Walk the dog"));
    await waitFor(() => toasts("status").some((t) => t.includes("Saved")));

    button(scope(), "Clear completed")?.click();
    await waitFor(() => document.querySelector('[role="alertdialog"]') !== null);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Delete 2 completed todos?",
    );
    button(document.body, "Clear")?.click();
    await waitFor(() => document.querySelector('[role="alertdialog"]') === null);
    await waitFor(() => titles().length === 0);
    await waitFor(() => toasts("status").some((t) => t.includes("Cleared 2 completed todos")));

    expect(unrendered).toEqual([]);
  }, 20_000);

  it("a failing save keeps the editor and the draft, and shows the error inline and as a toast", async () => {
    root = createHost();
    const api = new ScriptedTodoApi(seed);
    app = startApp(root, { api, notificationTimeoutMs: 60_000 });
    await waitFor(() => titles().length === 2);
    button(scope(), 'Edit "Buy milk"')?.click();
    await waitFor(() => editPanel() !== null);
    api.fail("update", "disk full");
    typeInto(editPanel()?.querySelector('input[aria-label="Title"]'), "Buy bread");
    await waitFor(() => button(editPanel() as Element, "Save")?.disabled === false);
    button(editPanel() as Element, "Save")?.click();
    await waitFor(
      () => editPanel()?.querySelector('[role="alert"]')?.textContent === "save failed: disk full",
    );
    expect(
      (editPanel()?.querySelector('input[aria-label="Title"]') as HTMLInputElement).value,
    ).toBe("Buy bread");
    await waitFor(() => toasts("alert").some((t) => t.includes("save failed: disk full")));
    expect(titles()).toContain("Buy milk");
  }, 10_000);

  it("dispose empties the page", async () => {
    root = createHost();
    const running = startApp(root);
    await waitFor(() => titles().length > 0);
    await running.dispose();
    expect(scope().childElementCount).toBe(0);
  });
});
