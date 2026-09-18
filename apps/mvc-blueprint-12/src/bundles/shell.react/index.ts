import { shellCoverage, shellRoot } from "@b/shell/api";
import { reactRenderersSlot } from "@b/shell/api/react";
import { type Controller, getSlots, useFields } from "@kernel";
import { createCoverage } from "@kit/host";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Shell } from "./host.js";

const fields = useFields({ slots: getSlots, root: shellRoot.get });

/**
 * `shell.react`: the React shell host. Renders header, main menu, panels (main as tabs, side
 * stacked), dialogs and notifications from the shell's slots, pairing each published view model
 * with the renderer for its kind from `ui.react:renderers`. Provides `shell:coverage`.
 */
export const activate: Controller = async (context) => {
  const { slots, root } = fields(context);
  const coverage = createCoverage(slots, reactRenderersSlot);
  shellCoverage.set(context, coverage);
  const container = document.createElement("div");
  container.dataset.shell = "react";
  root.append(container);
  const reactRoot = createRoot(container);
  flushSync(() => reactRoot.render(createElement(Shell, { slots })));
  return () => {
    reactRoot.unmount();
    container.remove();
    coverage.dispose();
  };
};
