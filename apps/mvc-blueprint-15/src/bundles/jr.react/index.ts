import { jrViewsSlot } from "@b/shell/api/jr";
import { type ReactRenderer, reactRenderersSlot } from "@b/shell/api/react";
import { type Controller, getLogger, getSlots } from "@kernel";
import { mirrorSlot } from "@kit/jr";
import { jrComponent } from "./view.js";

/**
 * `jr.react`: json-render as a React renderer technology. Every neutral `ui.jr:views` entry becomes
 * a `ui.react:renderers` entry (the React catalog renders its spec); the React shell host is
 * unaware. A refused write is logged as an error and dropped.
 */
export const activate: Controller = async (context) => {
  const logger = getLogger(context);
  const refuse = (message: string) => logger.error(message);
  return mirrorSlot(
    getSlots(context),
    jrViewsSlot,
    reactRenderersSlot,
    (view) =>
      ({
        kind: view.kind,
        component: jrComponent(view, refuse),
      }) as ReactRenderer<never>,
  );
};
