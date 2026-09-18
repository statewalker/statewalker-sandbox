import { defineKeyedSlot, type ViewKind } from "@kernel";

/** A plain-DOM renderer for one view kind: mounts into `host`, returns the unmount. */
export interface DomRenderer<M = unknown> {
  readonly kind: ViewKind<M>;
  mount(host: HTMLElement, model: M): () => void;
}
/** Keyed by kind id. Used by the DOM hosts. */
export const domRenderersSlot = defineKeyedSlot<DomRenderer<never>>("ui.dom:renderers");
