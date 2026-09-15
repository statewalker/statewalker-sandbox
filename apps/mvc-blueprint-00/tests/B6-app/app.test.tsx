import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { type RunningApp, seedTodos, startApp } from "../../src/app.js";
import { all, button, createHost, waitFor } from "../support/react.js";

/**
 * B6 · the real application, driven the way a user drives it.
 *
 * `startApp` is the very function `src/main.tsx` calls — the composition root,
 * not a test double of it — so this suite mounts what `pnpm dev` serves. Every
 * gesture goes through the DOM and every assertion reads the DOM: no model, no
 * controller and no command is named here. If the wiring between the layers is
 * wrong, the page is wrong, and that is what this suite looks at.
 */

let host: HTMLElement;
let app: RunningApp | undefined;
let bodyBefore: Element[];
let rejections: unknown[];
const onRejection = (event: PromiseRejectionEvent) => {
  rejections.push(event.reason);
};

beforeEach(() => {
  bodyBefore = [...document.body.children];
  host = createHost();
  rejections = [];
  window.addEventListener("unhandledrejection", onRejection);
});

afterEach(async () => {
  await app?.dispose();
  app = undefined;
  host.remove();
  window.removeEventListener("unhandledrejection", onRejection);
  vi.restoreAllMocks();
});

const titles = () => all(host, "li").map((li) => li.querySelector("label")?.textContent?.trim());
const row = (title: string) => all(host, "li").find((li) => li.textContent?.includes(title));
const checkbox = (title: string) => row(title)?.querySelector<HTMLInputElement>('input[type="checkbox"]');
const newTodo = () => {
  const el = host.querySelector<HTMLInputElement>('input[aria-label="New todo"]');
  if (!el) throw new Error('no "New todo" input');
  return el;
};
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const toast = () => document.querySelector<HTMLElement>('[role="status"]');

describe("B6 · the application, end to end", () => {
  it("add, toggle, clear completed through the confirm dialog, see the toast — then dispose leaves nothing", async () => {
    app = startApp(host);

    // The seeded list arrives through the controller's initial load.
    const seeded = seedTodos.map((t) => t.title);
    await waitFor(() => titles().length === seeded.length);
    expect(titles()).toEqual(seeded);
    const seededDone = seedTodos.filter((t) => t.done).length;
    expect(seededDone, "the seed needs a completed row for the clear to count").toBeGreaterThan(0);

    // Add: type a title, submit.
    await userEvent.type(newTodo(), "Water the plants");
    await userEvent.click(button(host, "Add")!);
    await waitFor(() => row("Water the plants") !== undefined);
    expect(titles()).toEqual([...seeded, "Water the plants"]);
    expect(newTodo().value, "the form clears once submitted").toBe("");
    expect(checkbox("Water the plants")?.checked).toBe(false);

    // Toggle: the tick is the controller's answer, not the view's guess.
    await userEvent.click(checkbox("Water the plants")!);
    await waitFor(() => checkbox("Water the plants")?.checked === true);
    expect(row("Water the plants")?.querySelector(".line-through")?.textContent).toBe("Water the plants");

    // Clear completed: a confirm dialog asks, counting what is completed.
    const cleared = seededDone + 1;
    await userEvent.click(button(host, "Clear completed")!);
    await waitFor(() => dialog() !== null);
    expect(dialog()?.textContent).toContain(`Clear ${cleared} completed todos?`);
    expect(titles(), "nothing is cleared before the user answers").toContain("Water the plants");

    await userEvent.click(button(dialog()!, "Confirm")!);
    await waitFor(() => row("Water the plants") === undefined);
    expect(titles()).toEqual(seedTodos.filter((t) => !t.done).map((t) => t.title));
    await waitFor(() => dialog() === null);
    // The keyboard user is back on the button they pressed, not on <body>.
    await waitFor(() => document.activeElement === button(host, "Clear completed"));

    // The toast announces what happened.
    await waitFor(() => toast() !== null);
    expect(toast()?.textContent).toContain(`Cleared ${cleared} completed todos`);

    // Teardown: every view is unmounted, portals included, and nothing leaked.
    await app.dispose();
    app = undefined;
    expect(host.childNodes, "the app's root is empty").toHaveLength(0);
    expect([...document.body.children], "no portal or container outlives the app").toEqual([...bodyBefore, host]);
    expect(toast()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejections).toEqual([]);
  });
});

describe("B6 · a list panel that fails to show is loud", () => {
  // `ListController.panelSettled` never rejects — it carries a failed panel as
  // `{ ok: false, error }` — and nothing in the library logs. So without a
  // reader, a view layer that forgot `ui:show-list` renders an empty page and
  // says nothing. The composition root is that reader.
  it("a view layer with no ui:show-list renderer: a visible error, and console.error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    app = startApp(host, { registerViews: () => () => undefined });

    await waitFor(() => host.querySelector('[role="alert"]') !== null);
    const alert = host.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain("no-handlers: ui:show-list");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0].join(" "))).toContain("no-handlers: ui:show-list");

    // The error is the app's own element, so it goes with the app.
    await app.dispose();
    app = undefined;
    expect(host.childNodes).toHaveLength(0);
    expect(rejections).toEqual([]);
  });

  it("an app disposed before its panel failure is read reports nothing — no log, no element", async () => {
    // The only window in which `disposed` matters: the panel's `no-handlers`
    // rejection is settled inside `startApp`, but its reader runs a few
    // microtasks later — and a caller that disposes in the same turn has
    // already been told the root is theirs again. (A healthy app never gets
    // here: dispose settles the panel `{ closed: true }`, which is not a
    // failure, so the test below cannot tell whether the guard exists.)
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const running = startApp(host, { registerViews: () => () => undefined });
    await running.dispose(); // same turn: the failure is still pending

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors, "nothing reports for an app the caller already tore down").not.toHaveBeenCalled();
    expect(host.childNodes, "nothing was rendered into the returned root").toHaveLength(0);
    expect(rejections).toEqual([]);
  });

  it("a healthy app renders no error and logs nothing — including across dispose", async () => {
    const errors = vi.spyOn(console, "error");

    app = startApp(host);
    await waitFor(() => titles().length === seedTodos.length);
    await app.dispose();
    app = undefined;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // dispose() settles the panel `{ closed: true }`: a clean close, not a failure.
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });
});
