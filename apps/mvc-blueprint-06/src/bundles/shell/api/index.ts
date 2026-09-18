/**
 * Shell API — declarations only. The shell's generic UI extension points (§14.2), expressed as
 * points OWNED BY THE `shell` ACTOR: contributors send it messages; it publishes each point as a
 * stream the host renders.
 */
import {
  type ActionDesc,
  definePoint,
  type PointMsg,
  type ViewRef,
} from "../../../kernel/index.js";

export const SHELL = "shell";
export type ShellMsg = PointMsg;

export interface HeaderItem {
  readonly order: number;
  readonly text: string;
  readonly tone?: "info" | "warn";
}

export interface MenuItem {
  readonly group: string;
  readonly groupLabel: string;
  readonly order: number;
  readonly action: ActionDesc;
}

export interface Panel extends ViewRef {
  readonly title: string;
  readonly placement: "main" | "side";
  readonly order?: number;
}

export interface Dialog extends ViewRef {
  readonly title: string;
}

export interface Notification {
  readonly message: string;
  readonly tone: "info" | "success" | "error";
  /** Sent by the host on dismiss; the publisher withdraws the notification. */
  readonly dismiss: ActionDesc;
}

export const header = definePoint<HeaderItem>("shell:header", SHELL);
export const menu = definePoint<MenuItem>("shell:menu", SHELL);
export const panels = definePoint<Panel>("shell:panels", SHELL);
export const dialogs = definePoint<Dialog>("shell:dialogs", SHELL);
export const notifications = definePoint<Notification>("shell:notifications", SHELL);

export const shellPoints = [header, menu, panels, dialogs, notifications] as const;
