/**
 * Shell API — the generic UI extension points (ARCHITECTURE §14.2), as store points.
 * Every contribution is plain data derived from some slice's state; the shell host selects the
 * points and renders them. "Panels" is literally `select(shellPanels)`.
 */
import {
  type ActionItem,
  defineMsg,
  definePoint,
  type Msg,
  type ViewKind,
} from "../../../kernel/index.ts";

export interface HeaderItem {
  readonly id: string;
  readonly order: number;
  readonly text: string;
  readonly tone?: "info" | "warn";
}
export interface MenuItem extends ActionItem {
  readonly group: string;
  readonly groupLabel: string;
}
export interface Panel<P = unknown> {
  readonly id: string;
  readonly kind: ViewKind<P>;
  readonly title: string;
  readonly placement: "main" | "side";
  readonly order?: number;
  readonly props: P;
}
export interface Dialog<P = unknown> {
  readonly id: string;
  readonly kind: ViewKind<P>;
  readonly title: string;
  readonly props: P;
}
export interface Notification {
  readonly id: string;
  readonly message: string;
  readonly tone: "info" | "success" | "error";
  /** Dispatched by the toast's close button: a view-side intent. */
  readonly dismiss: Msg;
}

export const shellHeader = definePoint<HeaderItem>("shell:header");
export const shellMenu = definePoint<MenuItem>("shell:menu");
export const shellPanels = definePoint<Panel>("shell:panels");
export const shellDialogs = definePoint<Dialog>("shell:dialogs");
export const shellNotifications = definePoint<Notification>("shell:notifications");

/** Answered by `shell.core`: shows a toast and withdraws it on dismiss or after the timeout. */
export const shellNotify = defineMsg<{ message: string; tone: Notification["tone"] }>(
  "shell/notify",
);

/** Host configuration: the toast timeout (tests inject a short one). */
export const NOTIFICATION_TIMEOUT_KEY = "shell:notification-timeout-ms";
