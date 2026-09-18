import { shellCoverage, shellRoot } from "@b/shell/api";
import { svelteRenderersSlot } from "@b/shell/api/svelte";
import { type Controller, getSlots, useFields } from "@kernel";
import { createCoverage } from "@kit/host";
import { flushSync, mount, unmount } from "svelte";
import Shell from "./Shell.svelte";

const fields = useFields({ slots: getSlots, root: shellRoot.get });

/**
 * `shell.svelte`: the Svelte shell host — header, main menu, panels (main as tabs, side stacked),
 * dialogs, notifications — pairing each published view model with its renderer from
 * `ui.svelte:renderers`. Provides `shell:coverage`.
 */
export const activate: Controller = async (context) => {
  const { slots, root } = fields(context);
  const coverage = createCoverage(slots, svelteRenderersSlot);
  shellCoverage.set(context, coverage);
  const container = document.createElement("div");
  container.dataset.shell = "svelte";
  root.append(container);
  const app = mount(Shell, { target: container, props: { slots } });
  flushSync();
  return () => {
    void unmount(app);
    container.remove();
    coverage.dispose();
  };
};
