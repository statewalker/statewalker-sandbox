import { type DomRenderer, domRenderersSlot } from "@b/shell/api/dom";
import { viewSpecsSlot } from "@b/shell/api/spec";
import { type Controller, getSlots } from "@kernel";
import { mirror } from "@kit/spec";
import { mountSpec } from "@kit/spec-dom";

/**
 * `ui.dom.spec`: plain DOM as a spec interpreter. Every view spec contributed to `ui:specs` becomes
 * a renderer in `ui.dom:renderers`; withdrawing the spec withdraws the renderer.
 */
export const activate: Controller = async (context) =>
  mirror(
    getSlots(context),
    viewSpecsSlot,
    domRenderersSlot,
    ({ kind, spec }) =>
      ({
        kind,
        mount: (host, model) => mountSpec(spec, host, model),
      }) satisfies DomRenderer<unknown> as unknown as DomRenderer<never>,
  );
