/** The shell API (§14.2): generic UI extension points, technology-neutral. Declarations only. */
import { defineService } from "../../../kernel/context.js";
import { defineIntent } from "../../../kernel/log.js";
import type { ActionView, ViewKind } from "../../../kernel/models.js";
import { defineKeyedSlot, defineSlot } from "../../../kernel/slots.js";

export interface HeaderItemState {
  readonly text: string;
  readonly tone?: "info" | "warn";
}
export interface HeaderItemView {
  getState(): HeaderItemState;
  onStateUpdate(listener: () => void): () => void;
}
export interface HeaderItem {
  readonly id: string;
  readonly order: number;
  readonly model: HeaderItemView;
}
export const headerSlot = defineSlot<HeaderItem>("shell:header");

export interface MenuItem {
  readonly id: string;
  readonly group: string;
  readonly groupLabel: string;
  readonly order: number;
  readonly action: ActionView;
}
export const menuSlot = defineSlot<MenuItem>("shell:menu");

export interface PanelContribution<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly title: string;
  readonly placement: "main" | "side";
  readonly order?: number;
  readonly model: M;
}
export const panelsSlot = defineKeyedSlot<PanelContribution>("shell:panels");

export interface DialogContribution<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly title: string;
  readonly model: M;
}
export const dialogsSlot = defineKeyedSlot<DialogContribution>("shell:dialogs");

export interface NotificationState {
  readonly message: string;
  readonly tone: "info" | "success" | "error";
}
export interface NotificationView {
  getState(): NotificationState;
  onStateUpdate(listener: () => void): () => void;
  /** a view-side intent; the publisher withdraws the contribution */
  dismiss(): void;
}
export interface NotificationEntry {
  readonly id: string;
  readonly model: NotificationView;
}
export const notificationsSlot = defineSlot<NotificationEntry>("shell:notifications");

/**
 * R3: a message for the user is an intent any bundle appends; `shell.notifications` answers it by
 * publishing a notification model (and withdrawing it on dismiss or timeout).
 */
export const notify = defineIntent<NotificationState>("shell:notify");

/** How long a notification stays (ms). Hosts and tests set it before activation; default 4000. */
export const [getNotificationTimeout, setNotificationTimeout, hasNotificationTimeout] =
  defineService<number>("shell:notification-timeout");
