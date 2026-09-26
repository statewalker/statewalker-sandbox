import { BaseClass } from "@statewalker/shared-baseclass";
import { Command } from "@statewalker/shared-commands";
import { z } from "zod";
import type { PanelModel } from "./panel-model.js";

// The app layer owns the `ui:*` vocabulary, so it also publishes the model
// types those payloads carry — that is how fm-ui reaches them without ever
// importing fm-core.
export { JobModel } from "@fm/core";

/**
 * D1 — every dialog kind gets its OWN command and its OWN typed model.
 *
 * A single descriptor-driven `ui:show-dialog` was considered and rejected: the
 * app knows its dialogs at compile time and should get typed models, and an
 * external contributor supplies their own command, model and renderer rather
 * than encoding a form in JSON.
 */

export class NotificationModel extends BaseClass {
  constructor(
    readonly level: "info" | "warning" | "error",
    readonly messageKey: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super();
  }
}

export class MenuModel extends BaseClass {
  constructor(readonly items: { key: string; label?: string; icon?: string }[]) {
    super();
  }
}

export class ConfirmDialogModel extends BaseClass {
  constructor(
    readonly messageKey: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super();
  }
}

export class PromptDialogModel extends BaseClass {
  /** The view writes here and nowhere else, exactly as in a panel. */
  readonly input = new (class extends BaseClass {
    text = "";
    submitCount = 0;
  })();
  error?: string;
  constructor(
    readonly messageKey: string,
    readonly initial = "",
  ) {
    super();
    this.input.text = initial;
  }
}

export class ConflictDialogModel extends BaseClass {
  constructor(
    readonly path: string,
    readonly target: string,
  ) {
    super();
  }
}

export const uiNotify = Command.required("ui:notify")
  .input(z.custom<NotificationModel>())
  .output(z.void())
  .build();

export const uiShowMenu = Command.required("ui:show-menu")
  .input(z.custom<MenuModel>())
  .output(z.object({ selectedKey: z.string().optional() }))
  .build();

export const uiShowConfirm = Command.required("ui:show-dialog:confirm")
  .input(z.custom<ConfirmDialogModel>())
  .output(z.object({ confirmed: z.boolean() }))
  .build();

export const uiShowPrompt = Command.required("ui:show-dialog:prompt")
  .input(z.custom<PromptDialogModel>())
  .output(z.object({ text: z.string() }))
  .build();

export const uiShowConflict = Command.required("ui:show-dialog:conflict")
  .input(z.custom<ConflictDialogModel>())
  .output(
    z.object({
      resolution: z.enum(["overwrite", "skip", "rename"]),
      applyToAll: z.boolean(),
    }),
  )
  .build();
