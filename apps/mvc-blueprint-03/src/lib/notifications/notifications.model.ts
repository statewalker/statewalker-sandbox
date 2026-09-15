import { defineViewKind } from "@sys/extension-points";

export type NotificationLevel = "info" | "error";

export interface NotificationMessage {
  readonly text: string;
  readonly level: NotificationLevel;
}

/** What a toast renders, and the one intent it raises. */
export interface NotificationView {
  getMessage(): NotificationMessage;
  dismiss(): void;
}

export interface NotificationControl {
  isDismissed(): boolean;
  onDismissedUpdate(listener: () => void): () => void;
}

/** The only transport of messages to the UI. */
export interface NotificationModel {
  readonly view: NotificationView;
  readonly control: NotificationControl;
  dispose(): void;
}

export const notificationKind = defineViewKind<NotificationView>("notifications:toast");
