import { type GeneratedView, generatedKind } from "@b/agent/api";
import { reactCatalogSlot } from "@b/catalog/api/react";
import { type ReactRenderer, reactRenderersSlot } from "@b/shell/api/react";
import type { ComponentRegistry } from "@json-render/react";
import { type Controller, getSlots, newRegistry } from "@kernel";
import { adapt, createGeneratedPanel } from "./view.js";

/**
 * `agent.ui.react`: the React renderer for `jr:generated`. Its activator (not the renderer) follows
 * `ui.react:catalog` and rebuilds the json-render registry when an implementation arrives or leaves.
 */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  let registry: ComponentRegistry = {};
  const listeners = new Set<() => void>();
  register(
    slots.observe(reactCatalogSlot, (entries) => {
      registry = Object.fromEntries([...entries].map(([name, e]) => [name, adapt(e.component)]));
      for (const l of [...listeners]) l();
    }),
  );
  const source = {
    get: () => registry,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  register(
    slots.register(reactRenderersSlot, generatedKind.id, {
      kind: generatedKind,
      component: createGeneratedPanel(source),
    } satisfies ReactRenderer<GeneratedView> as unknown as ReactRenderer<never>),
  );
  return cleanup;
};
