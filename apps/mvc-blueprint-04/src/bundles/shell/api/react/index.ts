import { defineKeyedSlot, type ViewKind } from "@kernel";
import type { ComponentType } from "react";

/** A React renderer for one view kind. */
export interface ReactRenderer<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly component: ComponentType<{ model: M }>;
}
/** Keyed by kind id. Used by the React host. */
export const reactRenderersSlot = defineKeyedSlot<ReactRenderer<never>>("ui.react:renderers");
