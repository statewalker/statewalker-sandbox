import { type SolidRenderer, solidRenderersSlot } from "@b/shell/api/solid";
import { type SvelteRenderer, svelteRenderersSlot } from "@b/shell/api/svelte";
import { type Controller, getSlots } from "@kernel";
import { type Component as SolidComponent, onCleanup } from "solid-js";
import { type Component as SvelteComponent, flushSync, mount, unmount } from "svelte";

/** A Solid component that hosts one Svelte component (an island) and tears it down with its owner. */
function island<M>(component: SvelteComponent<{ model: M }>): SolidComponent<{ model: M }> {
  return (props) => {
    const el = document.createElement("div");
    el.style.display = "contents";
    const app = mount(component, { target: el, props: { model: props.model } });
    flushSync();
    onCleanup(() => void unmount(app));
    return el;
  };
}

/**
 * `bridge.svelte-in-solid`: every Svelte renderer becomes a Solid renderer, so a Solid shell renders
 * Svelte panels. A renderer-slot to renderer-slot adapter: follows `ui.svelte:renderers` and
 * registers (and withdraws) the matching entry in `ui.solid:renderers`. No host or renderer knows.
 */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const bridged = new Map<string, { from: SvelteRenderer<never>; off: () => void }>();
  const offObserve = slots.observe(svelteRenderersSlot, (renderers) => {
    for (const [kind, entry] of bridged) {
      if (renderers.get(kind) === entry.from) continue;
      entry.off();
      bridged.delete(kind);
    }
    for (const [kind, from] of renderers) {
      if (bridged.has(kind)) continue;
      const to = { kind: from.kind, component: island(from.component) } as SolidRenderer<never>;
      bridged.set(kind, { from, off: slots.register(solidRenderersSlot, kind, to) });
    }
  });
  return () => {
    offObserve();
    for (const { off } of bridged.values()) off();
    bridged.clear();
  };
};
