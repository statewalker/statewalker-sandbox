import { defineKeyedSlot, defineSlot, type Slots } from "@statewalker/shared-slots";
import type { ActionView } from "./action/action.model.js";

export type { KeyedSlotDeclaration, SlotDeclaration } from "@statewalker/shared-slots";

/**
 * The app's extension points: slot declarations and the contributions they
 * carry. The UI imports this module to read what is contributed; controllers
 * import it to contribute. It holds no component.
 */
export interface ViewKind<M> {
  readonly id: string;
  /** Phantom: carries the model type for typed renderers. Never set. */
  readonly _model?: M;
}

export function defineViewKind<M>(id: string): ViewKind<M> {
  return Object.freeze({ id });
}

/** Where a panel goes. */
export type Placement = "main" | "side";

export interface PanelContribution<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly title: string;
  readonly placement: Placement;
  readonly model: M;
}

export interface DialogContribution<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly model: M;
}

export interface NotificationContribution<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly model: M;
}

/** An action offered at an extension point: a toolbar, a context menu. Any domain may contribute. */
export interface ActionContribution {
  readonly id: string;
  readonly order: number;
  readonly action: ActionView;
}

/** Keyed by panel id: a second, different panel under one id throws. */
export const panelsSlot = defineKeyedSlot<PanelContribution>("ui:panels");
export const dialogsSlot = defineSlot<DialogContribution>("ui:dialogs");
export const notificationsSlot = defineSlot<NotificationContribution>("ui:notifications");
/** Actions shown in the todo list's toolbar. */
export const todosToolbarActionsSlot = defineSlot<ActionContribution>("actions:todos.toolbar");
/** Actions that apply to the todo list's selection: the context menu. */
export const todosSelectionActionsSlot = defineSlot<ActionContribution>("actions:todos.selection");

/** Contributions in display order: by `order`, then by `id`. Returns a new array. */
export function sortActions(items: readonly ActionContribution[]): ActionContribution[] {
  return [...items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** What a UI may do with the slots bus: observe and read. Never provide. */
export type SlotsReader = Pick<Slots, "observe" | "getSnapshot" | "get">;

/** What a host is asked about: a contribution's kind, and — for a panel — its placement. */
export interface RenderQuery {
  readonly kind: ViewKind<unknown>;
  readonly placement?: Placement;
}

/** What the composition root holds for a mounted UI host. */
export interface UiHost {
  /** Whether this host puts `contribution` on screen when it arrives in the slot keyed `slot`. */
  renders(slot: string, contribution: RenderQuery): boolean;
  dispose(): void;
}
