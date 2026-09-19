import { type SolidRenderer, solidRenderersSlot } from "@b/shell/api/solid";
import { viewSpecsSlot } from "@b/shell/api/spec";
import { type Controller, getSlots } from "@kernel";
import { mirror } from "@kit/spec";
import { specComponent } from "@kit/spec-solid";

/**
 * `ui.solid.spec`: Solid as a spec interpreter. Every view spec contributed to `ui:specs` becomes
 * a renderer in `ui.solid:renderers`; withdrawing the spec withdraws the renderer.
 */
export const activate: Controller = async (context) =>
  mirror(
    getSlots(context),
    viewSpecsSlot,
    solidRenderersSlot,
    ({ kind, spec }) =>
      ({
        kind,
        component: specComponent(spec),
      }) satisfies SolidRenderer<unknown> as unknown as SolidRenderer<never>,
  );
