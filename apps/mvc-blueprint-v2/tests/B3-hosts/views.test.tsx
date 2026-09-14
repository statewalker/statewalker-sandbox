import { StatsController } from "@stats/app";
import { InspectorPanel } from "@stats/ui/react";
import { loggerBackendsSlot } from "@sys";
import { createConfirmDialogModel, createTodoListModel } from "@todo/app";
import { ConfirmView, ListView } from "@todo/ui";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { newTestContext } from "../support/context.js";
import { button, render, waitFor } from "../support/react.js";

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

describe("B3 · React views", () => {
  it("the list renders its visible rows and turns gestures into intents", async () => {
    const model = createTodoListModel();
    model.control.replaceTodos([{ id: "1", title: "buy milk", done: false }]);
    const view = render(<ListView model={model.view} />);
    unmount = view.unmount;
    await waitFor(() => view.host.textContent?.includes("buy milk") ?? false);
    await userEvent.fill(
      view.host.querySelector<HTMLInputElement>('input[aria-label="New todo"]')!,
      "walk dog",
    );
    await userEvent.click(button(view.host, "Add")!);
    expect(model.control.takePending()).toEqual([{ title: "walk dog" }]);
    await userEvent.click(button(view.host, "Add sample activity")!);
    expect(model.control.takeSampleRequests()).toEqual([5]);
    await userEvent.click(button(view.host, "Clear completed")!);
    expect(model.control.getClearCompletedCount()).toBe(1);
  });

  it("the confirm dialog shows its question and answers through its model", async () => {
    const dialog = createConfirmDialogModel("Clear 1 completed todo?");
    const view = render(<ConfirmView model={dialog.view} />);
    unmount = view.unmount;
    await waitFor(() => document.body.textContent?.includes("Clear 1 completed todo?") ?? false);
    await userEvent.click(button(document.body, "Confirm")!);
    expect(dialog.control.takeAnswer()).toBe(true);
  });

  it("the inspector renders records newest first and filters through its model", async () => {
    const { ctx, slots } = newTestContext();
    const stats = new StatsController({ tickMs: 60_000 });
    stats.activate(ctx);
    const write = (seq: number, level: "info" | "trace", event: string) =>
      slots.getSnapshot(loggerBackendsSlot)[0].write(
        Object.freeze({
          seq,
          at: Date.now(),
          level,
          args: [event, {}],
          metadata: { module: "demo" },
          dropped: 0,
        }),
      );
    write(1, "info", "first");
    write(2, "trace", "second");
    const view = render(<InspectorPanel model={stats.inspector.view} />);
    unmount = view.unmount;
    await waitFor(() => view.host.querySelectorAll("li[data-level]").length === 2);
    expect(view.host.querySelector("li[data-level]")?.textContent).toContain("second");
    await userEvent.selectOptions(
      view.host.querySelector<HTMLSelectElement>('select[aria-label="Minimum level"]')!,
      "info",
    );
    await waitFor(() => view.host.querySelectorAll("li[data-level]").length === 1);
    await stats.dispose();
  });
});
