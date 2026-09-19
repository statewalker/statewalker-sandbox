import type { Spec } from "@json-render/core";
import { defineKeyedSlot, type ViewKind } from "@kernel";
import type { ModelBinding } from "@kit/jr";

/**
 * A json-render view for one view kind, technology-neutral: the spec (data) and the binding of the
 * kind's view model to that spec (`@kit/jr`'s `ModelBinding`). Each technology's `jr.<tech>`
 * bundle turns every contribution into a renderer of its own renderer slot.
 */
export interface JrView<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly spec: Spec;
  readonly bind: (model: M) => ModelBinding;
}
/** Keyed by kind id. */
export const jrViewsSlot = defineKeyedSlot<JrView<never>>("ui.jr:views");
