import { Commands } from "@statewalker/shared-commands";
import { beforeEach, describe, expect, it } from "vitest";
import { MemTodoApi, TODO_COMMANDS, registerTodoCommands, todosResolveActions } from "@todo/core";
import { MenuController, type MenuModel, uiShowMenu } from "@todo/app";


describe("B3 · the menu is built from the declarations", () => {
  let commands: Commands;
  let shown: MenuModel | undefined;

  beforeEach(() => {
    commands = new Commands();
    registerTodoCommands(commands, new MemTodoApi());
    shown = undefined;
    // Stand in for the view layer: capture the model, pick nothing. Registered
    // at the same negative "default" priority `registerTodoCommands` uses, so
    // a per-test override at priority 0 (see below) wins the claim instead of
    // losing a same-priority tie to registration order.
    commands.listen(
      uiShowMenu,
      (cmd) => {
        shown = cmd.payload;
        return Promise.resolve({ selectedKey: undefined });
      },
      { priority: -1 },
    );
  });

  it("carries the label from each declaration, so the view never hard-codes one", async () => {
    await new MenuController(commands).openFor(["1"]);
    expect(shown?.items.map((i) => i.label)).toEqual(TODO_COMMANDS.map((c) => c.label));
  });

  it("offers only what resolve-actions allows", async () => {
    commands.listen(todosResolveActions, () => Promise.resolve({ keys: ["todos:toggle"] }), {
      priority: 0,
    });
    await new MenuController(commands).openFor(["1"]);
    expect(shown?.items.map((i) => i.key)).toEqual(["todos:toggle"]);
  });

  it("never offers the ui:* vocabulary, even though it is in the same bus", async () => {
    await new MenuController(commands).openFor(["1"]);
    for (const item of shown?.items ?? []) {
      expect(item.key.startsWith("ui:"), `${item.key} must not be offered`).toBe(false);
    }
  });

  it("returns the selected key to the caller", async () => {
    commands.listen(uiShowMenu, () => Promise.resolve({ selectedKey: "todos:remove" }), {
      priority: 0,
    });
    const picked = await new MenuController(commands).openFor(["1"]);
    expect(picked).toBe("todos:remove");
  });
});
