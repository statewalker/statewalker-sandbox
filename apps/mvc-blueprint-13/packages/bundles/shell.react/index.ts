import { shellCoverage, shellRoot } from "@p5/shell/api";
import { reactRenderersSlot } from "@p5/shell/api/react";
import { type Controller, getSlots, useFields } from "@p5/kernel";
import { createCoverage, newFocusReturn } from "@p5/kit-host";
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
export const activate: Controller = async (context, scope) => {
  const { slots, root } = fields(context);
  const coverage = createCoverage(slots, reactRenderersSlot);
  scope.defer(() => coverage.dispose());
  shellCoverage.set(context, coverage);
  const focus = newFocusReturn(root.ownerDocument);
  scope.defer(() => focus.dispose());
  const container = document.createElement("div");
  container.dataset.shell = "react";
  root.append(container);
  scope.defer(() => container.remove());
  const reactRoot = createRoot(container);
  scope.defer(() => reactRoot.unmount());
  flushSync(() => reactRoot.render(createElement(Shell, { slots, focus })));
};
