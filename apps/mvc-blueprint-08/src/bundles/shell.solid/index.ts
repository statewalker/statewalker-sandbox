import { shellCoverage, shellRoot } from "@b/shell/api";
import { solidRenderersSlot } from "@b/shell/api/solid";
import { type Controller, getSlots, useFields } from "@kernel";
import { createCoverage } from "@kit/host";
import { mountShell } from "./host.js";

const fields = useFields({ slots: getSlots, root: shellRoot.get });

/**
 * `shell.solid`: the Solid shell host — header, main menu, panels (main as tabs, side stacked),
 * dialogs, notifications — pairing each published view model with its renderer from
 * `ui.solid:renderers`. Provides `shell:coverage`.
 */
export const activate: Controller = async (context) => {
  const { slots, root } = fields(context);
  const coverage = createCoverage(slots, solidRenderersSlot);
  shellCoverage.set(context, coverage);
  const container = document.createElement("div");
  container.dataset.shell = "solid";
  root.append(container);
  const dispose = mountShell(container, slots);
  return () => {
    dispose();
    container.remove();
    coverage.dispose();
  };
};
