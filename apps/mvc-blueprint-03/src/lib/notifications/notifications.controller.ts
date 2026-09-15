import { getLogger } from "@statewalker/shared-logger";
import { newRegistry } from "@statewalker/shared-registry";
import { type AppContext, getCommands, getSlots } from "@sys/context";
import { notificationsSlot } from "@sys/extension-points";
import { notify } from "./notifications.commands.js";
import { createNotificationModel } from "./notifications.model.impl.js";
import { notificationKind } from "./notifications.model.js";

export const NOTIFICATION_TIMEOUT_MS = 4000;

export interface NotificationsControllerOptions {
  readonly timeoutMs?: number;
}

/** Answers `notify`: one toast per call, withdrawn on dismiss or after a timeout. */
export class NotificationsController {
  private readonly _registry = newRegistry();
  private _disposed = false;
  private _activated = false;

  constructor(private readonly _options: NotificationsControllerOptions = {}) {}

  activate(ctx: AppContext): void {
    if (this._activated) throw new Error("NotificationsController already activated");
    this._activated = true;
    const [register] = this._registry;
    const commands = getCommands(ctx);
    const slots = getSlots(ctx);
    const log = getLogger(ctx).child({ module: "notifications" });
    const timeoutMs = this._options.timeoutMs ?? NOTIFICATION_TIMEOUT_MS;

    register(
      commands.listen(notify, (cmd) => {
        if (this._disposed) return;
        const model = createNotificationModel(cmd.payload);
        const [own, releaseAll] = newRegistry();
        own(() => model.dispose());
        own(slots.provide(notificationsSlot, { kind: notificationKind, model: model.view }));
        // The controller's registry releases this toast on dispose; `release` is idempotent.
        const release = register(releaseAll);
        const timer = setTimeout(() => void release(), timeoutMs);
        own(() => clearTimeout(timer));
        // Never release inside the model's own listener: schedule it.
        own(
          model.control.onDismissedUpdate(() => {
            if (model.control.isDismissed()) queueMicrotask(() => void release());
          }),
        );
        log.info("notification:shown", { level: cmd.payload.level, text: cmd.payload.text });
        return Promise.resolve({ shown: true });
      }),
    );
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    const [, cleanup] = this._registry;
    await cleanup();
  }
}
