import { jrViewsSlot } from "@b/shell/api/jr";
import { type SolidRenderer, solidRenderersSlot } from "@b/shell/api/solid";
import { type Controller, getLogger, getSlots } from "@kernel";
import { mirrorSlot } from "@kit/jr";
import { jrComponent } from "./view.js";

/**
 * `jr.solid`: json-render as a Solid renderer technology. Every neutral `ui.jr:views` entry becomes
 * a `ui.solid:renderers` entry; the Solid shell host is unaware. A refused write is logged and dropped.
 */
export const activate: Controller = async (context) => {
  const logger = getLogger(context);
  const refuse = (message: string) => logger.error(message);
  return mirrorSlot(
    getSlots(context),
    jrViewsSlot,
    solidRenderersSlot,
    (view) =>
      ({
        kind: view.kind,
        component: jrComponent(view, refuse),
      }) as SolidRenderer<never>,
  );
};
