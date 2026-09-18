import { defineKeyedSlot, type ViewKind } from "@kernel";
import type { Component } from "vue";

/** A Vue renderer for one view kind: a component taking the view model as its `model` prop. */
export interface VueRenderer<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly component: Component<{ model: M }>;
}
/** Keyed by kind id. Used by the Vue host. */
export const vueRenderersSlot = defineKeyedSlot<VueRenderer<never>>("ui.vue:renderers");
