import type { Commands } from "@statewalker/shared-commands";
import { TODO_COMMANDS, todosResolveActions } from "@todo/core";
import { MenuModel, uiShowMenu } from "./ui-declarations.js";

/**
 * Builds the menu from the command declarations and shows it.
 *
 * The copy of `label`/`icon` into the model happens HERE because this is the
 * only layer allowed to read the registry — a view deriving menu items from the
 * declaration set would breach the layering, and B0 greps for exactly that.
 *
 * Applicability comes from `todos:resolve-actions`, not from the registry: a
 * registry is a flat catalog with no notion of it (drive file 06 §3), so
 * without this a right-click would offer the whole bus, `ui:*` included.
 */
export class MenuController {
  constructor(private readonly _commands: Commands) {}

  async openFor(ids: string[]): Promise<string | undefined> {
    const { keys } = await this._commands.call(todosResolveActions, { ids }).promise;
    const allowed = new Set(keys);
    const items = TODO_COMMANDS.filter((c) => allowed.has(c.key)).map((c) => ({
      key: c.key,
      label: c.label,
      icon: c.icon,
    }));
    const { selectedKey } = await this._commands.call(uiShowMenu, new MenuModel(items)).promise;
    return selectedKey;
  }
}
