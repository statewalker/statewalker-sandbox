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

  it("never offers a key outside its own catalog, even if resolve-actions returns one", async () => {
    // A misbehaving or over-permissive host returns something from the ui:
    // namespace. The menu is built by FILTERING the todos catalog by the resolved
    // keys, never by looking the resolved keys up in the open bus — so a ui: key
    // is not a candidate in the first place. Build-from-resolved-keys would fail here.
    commands.listen(
      todosResolveActions,
      () => Promise.resolve({ keys: ["todos:toggle", "ui:show-menu"] }),
      { priority: 0 },
    );
    await new MenuController(commands).openFor(["1"]);
    const keys = shown?.items.map((i) => i.key) ?? [];
    expect(keys).toContain("todos:toggle");
    expect(keys).not.toContain("ui:show-menu");
  });

  it("returns the selected key to the caller", async () => {
    commands.listen(uiShowMenu, () => Promise.resolve({ selectedKey: "todos:remove" }), {
      priority: 0,
    });
    const picked = await new MenuController(commands).openFor(["1"]);
    expect(picked).toBe("todos:remove");
  });
});
