import { type HelloView, helloKind } from "@b/hello/api";
import { type VueRenderer, vueRenderersSlot } from "@b/shell/api/vue";
import { type Controller, getSlots } from "@kernel";
import { Hello } from "./view.js";

/** `hello.ui.vue`: the hello panel's Vue renderer. */
export const activate: Controller = async (context) =>
  getSlots(context).register(vueRenderersSlot, helloKind.id, {
    kind: helloKind,
    component: Hello,
  } satisfies VueRenderer<HelloView> as unknown as VueRenderer<never>);
