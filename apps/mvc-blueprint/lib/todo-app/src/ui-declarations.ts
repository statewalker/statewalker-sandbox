import { BaseClass } from "@statewalker/shared-baseclass";
import { Command } from "@statewalker/shared-commands";
import { z } from "zod";
import type { TodoListModel } from "./todo-model.js";

/**
 * Panels, dialogs, notifications and menus are ONE mechanism at four
 * lifetimes. Each gets its own command and its own typed model — drive file 07
 * §4 reversed a generic `ui:dialog` for exactly this reason, and keying the
 * adapter on the declaration is what preserves it.
 *
 * These live in todo-app, not todo-core: the core names no `ui:` command, and
 * B0 greps for it.
 */
export class ConfirmModel extends BaseClass {
  constructor(readonly question: string) { super(); }
}
export class NotifyModel extends BaseClass {
  constructor(readonly text: string) { super(); }
}
export class MenuModel extends BaseClass {
  /** Built by the CONTROLLER from the declarations — the view may not read the registry. */
  constructor(readonly items: { key: string; label?: string; icon?: string }[]) { super(); }
}

export const uiShowList = Command.required("ui:show-list")
  .input(z.custom<TodoListModel>())
  .output(z.object({ closed: z.boolean() }))
  .build();

export const uiConfirm = Command.required("ui:show-dialog:confirm")
  .input(z.custom<ConfirmModel>())
  .output(z.object({ confirmed: z.boolean() }))
  .build();

export const uiNotify = Command.required("ui:notify")
  .input(z.custom<NotifyModel>())
  .output(z.void())
  .build();

export const uiShowMenu = Command.required("ui:show-menu")
  .input(z.custom<MenuModel>())
  .output(z.object({ selectedKey: z.string().optional() }))
  .build();
