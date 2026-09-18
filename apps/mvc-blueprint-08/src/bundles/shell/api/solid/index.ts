import { defineKeyedSlot, type ViewKind } from "@kernel";
import type { Component } from "solid-js";

/** A Solid renderer for one view kind: a component taking the view model as its `model` prop. */
export interface SolidRenderer<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly component: Component<{ model: M }>;
}
/** Keyed by kind id. Used by the Solid host. */
export const solidRenderersSlot = defineKeyedSlot<SolidRenderer<never>>("ui.solid:renderers");
