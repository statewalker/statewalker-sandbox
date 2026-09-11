import { Commands } from "@statewalker/shared-commands";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ConfirmModel, uiConfirm } from "@todo/app/models";
import { ConfirmView, registerViews } from "@todo/ui";
import { button, createHost, render, waitFor } from "../../test-support/react.js";

/**
 * B5 · the confirm dialog. Its whole contract is the result it settles, so the
 * isolated tests spy on `settle`; the last test goes through the bus to prove
 * that settling is also what takes it off the screen.
 */

const teardown: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) await fn();
});

/** Radix portals the dialog into `document.body`, not into the host. */
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

const mountConfirm = async (question: string) => {
  const settle = vi.fn<(r: { confirmed: boolean }) => void>();
  const view = render(<ConfirmView model={new ConfirmModel(question)} settle={settle} />);
  teardown.push(view.unmount);
  await waitFor(() => dialog() !== null);
  return { settle, dialog: dialog()! };
};

describe("ConfirmView", () => {
  it("opens at once, showing the model's question", async () => {
    const { dialog } = await mountConfirm("Remove 2 completed todos?");
    expect(dialog.textContent).toContain("Remove 2 completed todos?");
  });

  it("Confirm settles { confirmed: true } — once, though Radix closes the dialog as well", async () => {
    const { settle, dialog } = await mountConfirm("Remove?");
    await userEvent.click(button(dialog, "Confirm")!);
    expect(settle).toHaveBeenCalledExactlyOnceWith({ confirmed: true });
  });

  it("Cancel settles { confirmed: false }, once", async () => {
    const { settle, dialog } = await mountConfirm("Remove?");
    await userEvent.click(button(dialog, "Cancel")!);
    expect(settle).toHaveBeenCalledExactlyOnceWith({ confirmed: false });
  });

  it("Escape settles { confirmed: false }", async () => {
    const { settle } = await mountConfirm("Remove?");
    await userEvent.keyboard("{Escape}");
    expect(settle).toHaveBeenCalledExactlyOnceWith({ confirmed: false });
  });

  it("through the bus: answering resolves the command, and the settle unmounts the dialog", async () => {
    const commands = new Commands();
    const mount = createHost();
    const dispose = registerViews(mount)(commands);
    teardown.push(() => mount.remove(), dispose);

    const cmd = commands.call(uiConfirm, new ConfirmModel("Remove 1 completed todo?"));
    await waitFor(() => dialog() !== null);
    expect(mount.querySelector('[data-view="ui:show-dialog:confirm"]')).not.toBeNull();

    await userEvent.click(button(dialog()!, "Confirm")!);

    await expect(cmd.promise).resolves.toEqual({ confirmed: true });
    await waitFor(() => dialog() === null);
    expect(mount.children).toHaveLength(0);
  });
});
