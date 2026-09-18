import { defineKeyedSlot, type ViewKind } from "@kernel";
import type { Component } from "svelte";

/** A Svelte renderer for one view kind: a component taking the view model as its `model` prop. */
export interface SvelteRenderer<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly component: Component<{ model: M }>;
}
/** Keyed by kind id. Used by the Svelte host. */
export const svelteRenderersSlot = defineKeyedSlot<SvelteRenderer<never>>("ui.svelte:renderers");
