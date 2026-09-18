import { shellCoverage, shellRoot } from "@b/shell/api";
import { domRenderersSlot } from "@b/shell/api/dom";
import { type Controller, getSlots, useFields } from "@kernel";
import { createCoverage } from "@kit/host";
import { mountShell } from "./host.js";

const fields = useFields({ slots: getSlots, root: shellRoot.get });

/**
 * `shell.dom`: the plain-DOM shell host — header, main menu, panels (main as tabs, side stacked),
 * dialogs, notifications — pairing each published view model with its renderer from
 * `ui.dom:renderers`. Provides `shell:coverage`.
 */
export const activate: Controller = async (context) => {
  const { slots, root } = fields(context);
  const coverage = createCoverage(slots, domRenderersSlot);
  shellCoverage.set(context, coverage);
  const container = document.createElement("div");
  container.dataset.shell = "dom";
  container.className = "flex min-h-screen flex-col";
  root.append(container);
  const unmount = mountShell(container, slots);
  return () => {
    unmount();
    container.remove();
    coverage.dispose();
  };
};
