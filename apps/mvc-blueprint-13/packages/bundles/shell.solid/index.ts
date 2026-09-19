import { type Context, getLogger, getSlots, type Scope, useFields } from "@p5/kernel";
import { createCoverage, newFocusReturn } from "@p5/kit-host";
import { createShellHostModel } from "@p5/kit-shell";
import { shellCoverage, shellRoot } from "@p5/shell/api";
import { solidRenderersSlot } from "@p5/shell/api/solid";
import { mountShell } from "./host.js";

const fields = useFields({ slots: getSlots, log: getLogger, root: shellRoot.get });

/**
 * `shell.solid`: the Solid shell host — a renderer of the technology-neutral shell-host model
 * (`@p5/kit-shell`, D15) plus the DOM focus rule. Provides `shell:coverage`.
 */
export default async function shellSolid(context: Context, scope: Scope) {
  const { slots, log, root } = fields(context);
  const coverage = createCoverage(slots, solidRenderersSlot);
  scope.defer(() => coverage.dispose());
  shellCoverage.set(context, coverage);
  const model = createShellHostModel(slots, solidRenderersSlot);
  scope.defer(() => model.dispose());
  const focus = newFocusReturn(root.ownerDocument);
  scope.defer(() => focus.dispose());
  const container = document.createElement("div");
  container.dataset.shell = "solid";
  root.append(container);
  scope.defer(() => container.remove());
  scope.defer(
    mountShell(container, model.view, focus, (entry) => {
      log.error("shell:render-failed", entry);
      coverage.fail(entry);
    }),
  );
}
