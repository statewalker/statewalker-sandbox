import { newRegistry } from "@statewalker/shared-registry";
import { newChannels } from "@sys/model-kit";
import { signal } from "@sys/signals";
import type {
  NotificationControl,
  NotificationMessage,
  NotificationModel,
  NotificationView,
} from "./notifications.model.js";

export function createNotificationModel(message: NotificationMessage): NotificationModel {
  const [register, cleanup] = newRegistry();
  let disposed = false;
  const channels = newChannels(() => disposed);
  register(() => channels.dispose());

  const frozen: NotificationMessage = Object.freeze({ text: message.text, level: message.level });
  const dismissed = signal(false);

  const view: NotificationView = Object.freeze({
    getMessage: () => frozen,
    dismiss: () => {
      if (!disposed) dismissed(true);
    },
  });
  const control: NotificationControl = Object.freeze({
    isDismissed: () => dismissed(),
    onDismissedUpdate: channels.channel(dismissed),
  });
  return Object.freeze({
    view,
    control,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      void cleanup();
    },
  });
}
