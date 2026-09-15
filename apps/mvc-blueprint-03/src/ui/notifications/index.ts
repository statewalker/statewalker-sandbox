import { notificationKind } from "@notifications/model";
import { type ReactRenderer, reactRenderer } from "@ui/host";
import { NotificationToast } from "./toast-view.js";

export { NotificationToast };
export const notificationRenderers: readonly ReactRenderer[] = [
  reactRenderer(notificationKind, NotificationToast),
];
