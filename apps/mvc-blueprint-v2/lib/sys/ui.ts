import { defineKeyedSlot, defineSlot, type Slots } from "@statewalker/shared-slots";

/**
 * The UI's extension points — the ONLY slot declarations a UI module may import
 * (B0). A contribution carries a view kind and a MODELS.md view facet; a host
 * renders the kinds it has renderers for.
 */
export interface ViewKind<M> {
  readonly id: string;
  /** Phantom: carries the model type for typed renderers. Never set. */
  readonly _model?: M;
}

export function defineViewKind<M>(id: string): ViewKind<M> {
  return Object.freeze({ id });
}

/** Where a panel goes. Part of the contract: one generic slot would render everything everywhere. */
export type Placement = "main" | "side" | "bottom";

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

export interface ProgressContribution<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly model: M;
}

/** Keyed by panel id: a second, different panel under one id throws — as a duplicate activation should. */
export const panelsSlot = defineKeyedSlot<PanelContribution>("ui:panels");
export const dialogsSlot = defineSlot<DialogContribution>("ui:dialogs");
export const progressSlot = defineSlot<ProgressContribution>("ui:progress");

/** What a UI host may do with the bus: observe and read. Never provide. */
export type SlotsReader = Pick<Slots, "observe" | "getSnapshot" | "get">;
