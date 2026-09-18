import type { Controller } from "../../kernel/context.js";
import { useFields } from "../../kernel/context.js";
import { defineIntent, openLog } from "../../kernel/log.js";
import { getSlots } from "../../kernel/slots.js";
import { cell } from "../../kit/cell.js";
import {
  getNotificationTimeout,
  hasNotificationTimeout,
  type NotificationView,
  notificationsSlot,
  notify,
} from "../shell/api/index.js";

/** Private: the view's dismiss gesture, answered here. */
const dismiss = defineIntent<{ id: string }>("shell.notifications:dismiss");

const fields = useFields({ slots: getSlots });

/** Answers `shell:notify`: publishes a toast model, withdraws it on dismiss or after the timeout. */
export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const timeout = hasNotificationTimeout(context) ? getNotificationTimeout(context) : 4000;
  const log = openLog(context, "shell.notifications");
  const live = new Map<string, () => void>();

  const withdraw = (id: string) => {
    live.get(id)?.();
    live.delete(id);
  };

  log.handle(notify, ({ seq, payload }) => {
    const id = `notification-${seq}`;
    const state = cell(payload);
    const model: NotificationView = Object.freeze({
      getState: state.get,
      onStateUpdate: state.subscribe,
      dismiss: () => void (!log.closed && live.has(id) && log.append(dismiss, { id })),
    });
    const unpublish = slots.provide(notificationsSlot, { id, model });
    const timer = setTimeout(() => withdraw(id), timeout);
    live.set(id, () => {
      clearTimeout(timer);
      unpublish();
      state.dispose();
    });
  });
  log.handle(dismiss, ({ payload }) => withdraw(payload.id));

  return () => {
    for (const id of [...live.keys()]) withdraw(id);
    log.close();
  };
};
