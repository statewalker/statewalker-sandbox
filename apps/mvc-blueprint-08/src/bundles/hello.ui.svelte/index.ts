import { type HelloView, helloKind } from "@b/hello/api";
import { type SvelteRenderer, svelteRenderersSlot } from "@b/shell/api/svelte";
import { type Controller, getSlots } from "@kernel";
import Hello from "./Hello.svelte";

/** `hello.ui.svelte`: the hello panel's Svelte renderer. */
export const activate: Controller = async (context) =>
  getSlots(context).register(svelteRenderersSlot, helloKind.id, {
    kind: helloKind,
    component: Hello,
  } satisfies SvelteRenderer<HelloView> as unknown as SvelteRenderer<never>);
