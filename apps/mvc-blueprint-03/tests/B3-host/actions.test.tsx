import { Slots } from "@statewalker/shared-slots";
import { createAction } from "@sys/action";
import { todosSelectionActionsSlot, todosToolbarActionsSlot } from "@sys/extension-points";
import { SlotsProvider } from "@ui/host";
import { ActionBar, ActionButton, ActionMenu } from "@ui/sys/action";
import { describe, expect, it, vi } from "vitest";
import { all, button, render, waitFor } from "../support/react.js";

describe("B3 · action components", () => {
  it("ActionButton renders the action's state live and submits on click", async () => {
    const action = createAction({ label: "Save", icon: "save", hint: "Save the draft" });
    const view = render(<ActionButton action={action.view} />);
    await waitFor(() => button(view.host, "Save") !== undefined);
    const b = button(view.host, "Save") as HTMLButtonElement;
    expect([b.disabled, b.getAttribute("data-icon"), b.title]).toEqual([
      false,
      "save",
      "Save the draft",
    ]);
    b.click();
    expect(action.control.getSubmits()).toBe(1);
    action.control.update({ running: true, label: "Saving" });
    await waitFor(() => button(view.host, "Saving")?.disabled === true);
    expect(button(view.host, "Saving")?.getAttribute("aria-busy")).toBe("true");
    action.control.update({ running: false, enabled: false });
    await waitFor(() => button(view.host, "Saving")?.getAttribute("aria-busy") === "false");
    expect(button(view.host, "Saving")?.disabled).toBe(true);
    view.unmount();
  });

  it("ActionBar renders a slot's actions in order, and follows contributions as they come and go", async () => {
    const slots = new Slots();
    const add = createAction({ label: "Add" });
    const clear = createAction({ label: "Clear completed" });
    slots.provide(todosToolbarActionsSlot, {
      id: "todos.clear-completed",
      order: 20,
      action: clear.view,
    });
    const view = render(
      <SlotsProvider slots={slots}>
        <ActionBar slot={todosToolbarActionsSlot} label="Todo actions" />
      </SlotsProvider>,
    );
    await waitFor(() => all(view.host, "button").length === 1);
    const off = slots.provide(todosToolbarActionsSlot, {
      id: "todos.add",
      order: 10,
      action: add.view,
    });
    await waitFor(() => all(view.host, "button").length === 2);
    expect(all(view.host, "button").map((b) => b.textContent)).toEqual(["Add", "Clear completed"]);
    expect(view.host.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe(
      "Todo actions",
    );
    clear.control.update({ enabled: false });
    await waitFor(() => button(view.host, "Clear completed")?.disabled === true);
    add.control.update({ running: true });
    await waitFor(() => button(view.host, "Add")?.getAttribute("aria-busy") === "true");
    expect(button(view.host, "Add")?.disabled).toBe(true);
    off();
    await waitFor(() => all(view.host, "button").length === 1);
    view.unmount();
  });

  it("ActionMenu submits an enabled item and closes; items follow enabled and running; Escape closes", async () => {
    const slots = new Slots();
    const toggle = createAction({ label: "Toggle" });
    const edit = createAction({ label: "Edit", enabled: false });
    slots.provide(todosSelectionActionsSlot, {
      id: "todos.toggle",
      order: 10,
      action: toggle.view,
    });
    slots.provide(todosSelectionActionsSlot, { id: "todos.edit", order: 20, action: edit.view });
    const onClose = vi.fn();
    const view = render(
      <SlotsProvider slots={slots}>
        <ActionMenu
          slot={todosSelectionActionsSlot}
          label="Selection actions"
          position={{ x: 10, y: 10 }}
          onClose={onClose}
        />
      </SlotsProvider>,
    );
    await waitFor(() => all(view.host, '[role="menuitem"]').length === 2);
    const [toggleItem, editItem] = all<HTMLButtonElement>(view.host, '[role="menuitem"]');
    expect(editItem.disabled).toBe(true);
    editItem.click();
    expect(edit.control.getSubmits()).toBe(0);
    toggleItem.click();
    expect(toggle.control.getSubmits()).toBe(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    toggle.control.update({ running: true });
    await waitFor(() => all<HTMLButtonElement>(view.host, '[role="menuitem"]')[0].disabled);
    edit.control.update({ enabled: true });
    await waitFor(() => !all<HTMLButtonElement>(view.host, '[role="menuitem"]')[1].disabled);
    view.host
      .querySelector('[role="menu"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});
