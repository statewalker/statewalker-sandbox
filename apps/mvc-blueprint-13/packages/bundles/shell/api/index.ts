import {
  type ActionView,
  defineKeyedSlot,
  defineSlot,
  type Listener,
  newAdapter,
  type Unsubscribe,
  type ViewKind,
} from "@p5/kernel";

/**
 * The shell API: the generic UI extension points every shell host implements. Declarations only,
 * technology-neutral (renderer extension points live in `shell/api/react` and `shell/api/dom`).
 */

// ── header ───────────────────────────────────────────────────────────────────────────────────
export interface HeaderItemState {
  readonly text: string;
  readonly tone?: "info" | "warn";
}
export interface HeaderItemView {
  getState(): HeaderItemState;
  onStateUpdate(listener: Listener): Unsubscribe;
}
export interface HeaderContribution {
  readonly id: string;
  readonly order: number;
  readonly model: HeaderItemView;
}
/** Text items in the header, by `order` then `id`; rendered by the shell itself. */
export const headerSlot = defineSlot<HeaderContribution>("shell:header");

// ── main menu ────────────────────────────────────────────────────────────────────────────────
export interface MenuContribution {
  readonly id: string;
  readonly group: string;
  readonly groupLabel: string;
  readonly order: number;
  readonly action: ActionView;
}
/** A main menu: one sub-menu per group, items by `order` then `id`. */
export const menuSlot = defineSlot<MenuContribution>("shell:menu");

// ── panels and dialogs ───────────────────────────────────────────────────────────────────────
export type Placement = "main" | "side";
export interface PanelContribution<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly title: string;
  readonly placement: Placement;
  readonly order?: number;
  readonly model: M;
}
/** Keyed by panel id. `main`: tabs by `order` then insertion; `side`: stacked beside main. */
export const panelsSlot = defineKeyedSlot<PanelContribution>("shell:panels");

export interface DialogContribution<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly title: string;
  readonly model: M;
}
/** Keyed by dialog id. Modal; the most recent on top; focus returns on withdrawal. */
export const dialogsSlot = defineKeyedSlot<DialogContribution>("shell:dialogs");

// ── notifications ────────────────────────────────────────────────────────────────────────────
export interface NotificationState {
  readonly message: string;
  readonly tone: "info" | "success" | "error";
}
export interface NotificationView {
  getState(): NotificationState;
  onStateUpdate(listener: Listener): Unsubscribe;
  /** A view-side intent; the publisher withdraws the contribution. */
  dismiss(): void;
}
export interface NotificationContribution {
  readonly id: string;
  readonly model: NotificationView;
}
/** Toasts, newest last; the shell renders them itself. Published and withdrawn by their owner. */
export const notificationsSlot = defineSlot<NotificationContribution>("shell:notifications");
/** `sys:config` key: how long a notification stays (ms). Hosts and tests set it; default 4000. */
export const NOTIFICATION_TIMEOUT_KEY = "shell:notification-timeout-ms";

// ── services a shell host provides ──────────────────────────────────────────────────────────
/** The element a DOM-based host renders into. Set by the application's entry (the host). */
export const shellRoot = newAdapter<Element>("shell:root");

export interface CoverageEntry {
  readonly slot: string;
  readonly id: string;
  readonly kind: string;
}
export interface UnobservedEntry {
  readonly slot: string;
  readonly contributions: number;
}
export interface FailedEntry {
  readonly slot: string;
  readonly id: string;
  /** The failure, as a message. */
  readonly error: string;
}
export interface CoverageReport {
  /** Panels and dialogs whose kind has no renderer in this host. */
  readonly unrendered: readonly CoverageEntry[];
  /** Contributions whose rendering threw: contained by the host, shown as failed, listed here. */
  readonly failed: readonly FailedEntry[];
  /** Slots holding contributions that no one observes. */
  readonly unobserved: readonly UnobservedEntry[];
}
export interface CoverageView {
  getReport(): CoverageReport;
  onReportUpdate(listener: Listener): Unsubscribe;
}
/** The active host's coverage report. Provided by the shell host bundle. */
export const shellCoverage = newAdapter<CoverageView>("shell:coverage");
