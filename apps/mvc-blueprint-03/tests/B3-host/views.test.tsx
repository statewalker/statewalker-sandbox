import { Slots } from "@statewalker/shared-slots";
import { createNotificationModel } from "@notifications";
import { todosSelectionActionsSlot, todosToolbarActionsSlot } from "@sys/extension-points";
import { createConfirmModel } from "@todos/clear-completed";
import { createEditModel } from "@todos/edit";
import { createTodoListModel } from "@todos/list";
import { SlotsProvider } from "@ui/host";
import { NotificationToast } from "@ui/notifications";
import { ClearCompletedConfirm } from "@ui/todos/clear-completed";
import { TodoEditPanel } from "@ui/todos/edit";
import { TodoListPanel } from "@ui/todos/list";
import { describe, expect, it } from "vitest";
import { all, button, render, typeInto, waitFor } from "../support/react.js";

const rows = [
  { id: "t1", title: "Buy milk", done: false },
  { id: "t2", title: "Walk dog", done: true },
];

function listSetup() {
  const model = createTodoListModel();
  model.control.replaceItems(rows);
  const slots = new Slots();
  const { actions } = model.view;
  slots.provide(todosToolbarActionsSlot, { id: "todos.add", order: 10, action: actions.add });
  slots.provide(todosToolbarActionsSlot, {
    id: "todos.clear-completed",
    order: 20,
    action: actions.clearCompleted,
  });
  slots.provide(todosSelectionActionsSlot, {
    id: "todos.toggle",
    order: 10,
    action: actions.toggle,
  });
  slots.provide(todosSelectionActionsSlot, { id: "todos.edit", order: 20, action: actions.edit });
  slots.provide(todosSelectionActionsSlot, {
    id: "todos.remove",
    order: 30,
    action: actions.remove,
  });
  const view = render(
    <SlotsProvider slots={slots}>
      <TodoListPanel model={model.view} />
    </SlotsProvider>,
  );
  const row = (id: string) => view.host.querySelector(`[data-todo="${id}"]`) as HTMLElement;
  return { model, view, row };
}

describe("B3 · todo list panel", () => {
  it("renders the visible rows, the toolbar, and typing and filtering write the model", async () => {
    const { model, view } = listSetup();
    await waitFor(() => all(view.host, "[data-todo]").length === 2);
    expect(all(view.host, '[role="toolbar"] button').map((b) => b.textContent)).toEqual([
      "Add",
      "Clear completed",
    ]);
    typeInto(view.host.querySelector('input[aria-label="New todo"]'), "Call mum");
    expect(model.view.getNewTitle()).toBe("Call mum");
    typeInto(view.host.querySelector('input[aria-label="Filter"]'), "milk");
    await waitFor(() => all(view.host, "[data-todo]").length === 1);
    view.unmount();
  });

  it("submitting the new-todo form submits Add", async () => {
    const { model, view } = listSetup();
    await waitFor(() => view.host.querySelector('input[aria-label="New todo"]') !== null);
    typeInto(view.host.querySelector('input[aria-label="New todo"]'), "Call mum");
    await waitFor(() => button(view.host, "Add")?.disabled === false);
    view.host.querySelector("form")?.requestSubmit();
    expect(model.control.actions.add.getSubmits()).toBe(1);
    view.unmount();
  });

  it("a row's checkbox selects the row and submits Toggle", async () => {
    const { model, view } = listSetup();
    await waitFor(() => view.host.querySelector('input[aria-label="Done: Walk dog"]') !== null);
    (view.host.querySelector('input[aria-label="Done: Walk dog"]') as HTMLInputElement).click();
    expect(model.view.getSelection()).toEqual(["t2"]);
    expect(model.control.actions.toggle.getSubmits()).toBe(1);
    view.unmount();
  });

  it("a row's Delete and Edit buttons select the row and submit their action", async () => {
    const { model, view } = listSetup();
    await waitFor(() => button(view.host, 'Delete "Buy milk"') !== undefined);
    button(view.host, 'Delete "Buy milk"')?.click();
    expect([model.view.getSelection(), model.control.actions.remove.getSubmits()]).toEqual([
      ["t1"],
      1,
    ]);
    button(view.host, 'Edit "Walk dog"')?.click();
    expect([model.view.getSelection(), model.control.actions.edit.getSubmits()]).toEqual([
      ["t2"],
      1,
    ]);
    view.unmount();
  });

  it("a row's controls are disabled and busy while their action runs", async () => {
    const { model, view } = listSetup();
    const checkboxes = () => all<HTMLInputElement>(view.host, 'input[aria-label^="Done: "]');
    const rowButtons = (verb: string) =>
      all<HTMLButtonElement>(view.host, `button[aria-label^="${verb} "]`);
    await waitFor(() => checkboxes().length === 2);
    expect(checkboxes().map((c) => c.disabled)).toEqual([false, false]);

    model.control.actions.toggle.update({ running: true });
    await waitFor(() => checkboxes().every((c) => c.disabled));
    expect(checkboxes().map((c) => c.getAttribute("aria-busy"))).toEqual(["true", "true"]);
    expect(rowButtons("Delete").map((b) => b.disabled)).toEqual([false, false]);
    model.control.actions.toggle.update({ running: false });
    await waitFor(() => checkboxes().every((c) => !c.disabled));

    model.control.actions.remove.update({ running: true });
    await waitFor(() => rowButtons("Delete").every((b) => b.disabled));
    expect(rowButtons("Delete").map((b) => b.getAttribute("aria-busy"))).toEqual(["true", "true"]);
    expect(rowButtons("Edit").map((b) => b.disabled)).toEqual([false, false]);
    model.control.actions.remove.update({ running: false });
    await waitFor(() => rowButtons("Delete").every((b) => !b.disabled));

    model.control.actions.edit.update({ running: true });
    await waitFor(() => rowButtons("Edit").every((b) => b.disabled));
    model.control.actions.edit.update({ running: false });
    await waitFor(() => rowButtons("Edit").every((b) => !b.disabled));
    view.unmount();
  });

  it("click selects, Ctrl-click extends, and the selection shows", async () => {
    const { model, view, row } = listSetup();
    await waitFor(() => row("t1") !== null);
    row("t1").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    row("t2").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(model.view.getSelection()).toEqual(["t1", "t2"]);
    await waitFor(() => row("t2").getAttribute("aria-selected") === "true");
    row("t1").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(model.view.getSelection()).toEqual(["t2"]);
    view.unmount();
  });

  it("right-click opens the selection menu from the slot; choosing Delete submits it and closes", async () => {
    const { model, view, row } = listSetup();
    await waitFor(() => row("t1") !== null);
    row("t1").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 40 }),
    );
    await waitFor(() => view.host.querySelector('[role="menu"]') !== null);
    expect(model.view.getSelection()).toEqual(["t1"]);
    const items = all<HTMLButtonElement>(view.host, '[role="menuitem"]');
    expect(items.map((b) => b.textContent)).toEqual(["Toggle", "Edit", "Delete"]);
    items[2].click();
    expect(model.control.actions.remove.getSubmits()).toBe(1);
    await waitFor(() => view.host.querySelector('[role="menu"]') === null);
    view.unmount();
  });

  it("shows the outcome while it is set", async () => {
    const { model, view } = listSetup();
    model.control.reportOutcome('add "x" failed: disk full');
    await waitFor(
      () => view.host.querySelector('[role="alert"]')?.textContent === 'add "x" failed: disk full',
    );
    model.control.reportOutcome(undefined);
    await waitFor(() => view.host.querySelector('[role="alert"]') === null);
    view.unmount();
  });
});

describe("B3 · edit panel", () => {
  it("edits the draft; Save enables when dirty; the error renders; Save and Cancel submit", async () => {
    const model = createEditModel(rows[0]);
    const view = render(<TodoEditPanel model={model.view} />);
    await waitFor(() => button(view.host, "Save") !== undefined);
    expect(button(view.host, "Save")?.disabled).toBe(true);
    typeInto(view.host.querySelector('input[aria-label="Title"]'), "Buy oat milk");
    expect(model.view.form.getDraft().title).toBe("Buy oat milk");
    await waitFor(() => button(view.host, "Save")?.disabled === false);
    (view.host.querySelector('input[aria-label="Done"]') as HTMLInputElement).click();
    expect(model.view.form.getDraft().done).toBe(true);
    model.control.reportError("save failed: disk full");
    await waitFor(
      () => view.host.querySelector('[role="alert"]')?.textContent === "save failed: disk full",
    );
    button(view.host, "Save")?.click();
    button(view.host, "Cancel")?.click();
    expect([
      model.control.actions.save.getSubmits(),
      model.control.actions.cancel.getSubmits(),
    ]).toEqual([1, 1]);
    view.unmount();
  });
});

describe("B3 · confirm dialog and toast", () => {
  it("the confirm dialog shows the question; its buttons submit OK and Cancel", async () => {
    const model = createConfirmModel({ text: "Delete 2 completed todos?", count: 2 });
    const view = render(<ClearCompletedConfirm model={model.view} />);
    await waitFor(() => document.querySelector('[role="alertdialog"]') !== null);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Delete 2 completed todos?",
    );
    button(document.body, "Clear")?.click();
    button(document.body, "Cancel")?.click();
    expect([
      model.control.actions.ok.getSubmits(),
      model.control.actions.cancel.getSubmits(),
    ]).toEqual([1, 1]);
    view.unmount();
  });

  it("a toast shows its message by level, and Dismiss dismisses", async () => {
    const info = createNotificationModel({ text: "Saved", level: "info" });
    const error = createNotificationModel({ text: "save failed: disk full", level: "error" });
    const view = render(
      <>
        <NotificationToast model={info.view} />
        <NotificationToast model={error.view} />
      </>,
    );
    await waitFor(
      () => view.host.querySelector('[role="status"]')?.textContent?.includes("Saved") === true,
    );
    expect(view.host.querySelector('[role="alert"]')?.getAttribute("data-level")).toBe("error");
    all<HTMLButtonElement>(view.host, 'button[aria-label="Dismiss"]')[0].click();
    expect([info.control.isDismissed(), error.control.isDismissed()]).toEqual([true, false]);
    view.unmount();
  });
});
