import { Command } from "@statewalker/shared-commands";
import { z } from "zod";
import type { TodoListView } from "./todo-model.js";

/**
 * Panels, dialogs, notifications and menus are ONE mechanism at four
 * lifetimes. Each gets its own command and its own typed model — drive file 07
 * §4 reversed a generic `ui:dialog` for exactly this reason, and keying the
 * adapter on the declaration is what preserves it.
 *
 * These live in todo-app, not todo-core: the core names no `ui:` command, and
 * B0 greps for it.
 */
/**
 * Plain readonly records, not signals: nothing in them changes after the
 * controller builds them, so there is nothing to observe.
 */
export class ConfirmModel {
  constructor(readonly question: string) {}
}
export class NotifyModel {
  constructor(readonly text: string) {}
}
export class MenuModel {
  /** Built by the CONTROLLER from the declarations — the view may not read the registry. */
  constructor(readonly items: { key: string; label?: string; icon?: string }[]) {}
}

export const uiShowList = Command.required("ui:show-list")
  .input(z.custom<TodoListView>())
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
