import { Commands } from "@statewalker/shared-commands";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { MenuModel, uiShowMenu } from "@todo/app/models";
import { MenuView, registerViews } from "@todo/ui";
import { all, button, createHost, render, waitFor } from "../../test-support/react.js";

/**
 * B5 · the context menu. Registered and tested in isolation: nothing in the
 * list opens it yet (that gesture is a later task). Its items come from the
 * MODEL, which the controller filled from the declarations (spec §4.4) — the
 * view never reads the registry.
 */

const teardown: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) await fn();
});

const items = [
  { key: "todos:toggle", label: "Toggle", icon: "check" },
  { key: "todos:remove", label: "Delete", icon: "trash-2" },
  { key: "todos:unlabelled" },
];

const mountMenu = async () => {
  const settle = vi.fn<(r: { selectedKey?: string }) => void>();
  const view = render(<MenuView model={new MenuModel(items)} settle={settle} />);
  teardown.push(view.unmount);
  await waitFor(() => view.host.querySelector('[role="menu"]') !== null);
  return { settle, host: view.host };
};

describe("MenuView", () => {
  it("renders one button per item, labelled from the model — falling back to the key", async () => {
    const { host } = await mountMenu();
    const labels = all(host, '[role="menuitem"]').map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Toggle", "Delete", "todos:unlabelled"]);
  });

  it("clicking an item settles { selectedKey } — once", async () => {
    const { settle, host } = await mountMenu();
    await userEvent.click(button(host, "Delete")!);
    await userEvent.keyboard("{Escape}");
    expect(settle).toHaveBeenCalledExactlyOnceWith({ selectedKey: "todos:remove" });
  });

  it("Escape settles {} — nothing chosen", async () => {
    const { settle } = await mountMenu();
    await userEvent.keyboard("{Escape}");
    expect(settle).toHaveBeenCalledExactlyOnceWith({});
  });

  it("through the bus: choosing resolves the command, and the settle unmounts the menu", async () => {
    const commands = new Commands();
    const mount = createHost();
    const dispose = registerViews(mount)(commands);
    teardown.push(() => mount.remove(), dispose);

    const cmd = commands.call(uiShowMenu, new MenuModel(items));
    await waitFor(() => mount.querySelector('[data-view="ui:show-menu"] [role="menu"]') !== null);

    await userEvent.click(button(mount, "Toggle")!);

    await expect(cmd.promise).resolves.toEqual({ selectedKey: "todos:toggle" });
    await waitFor(() => mount.children.length === 0);
  });
});
