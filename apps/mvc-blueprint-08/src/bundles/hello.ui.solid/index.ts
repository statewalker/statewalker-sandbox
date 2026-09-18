import { type HelloView, helloKind } from "@b/hello/api";
import { type SolidRenderer, solidRenderersSlot } from "@b/shell/api/solid";
import { type Controller, getSlots } from "@kernel";
import { Hello } from "./view.js";

/** `hello.ui.solid`: the hello panel's Solid renderer. */
export const activate: Controller = async (context) =>
  getSlots(context).register(solidRenderersSlot, helloKind.id, {
    kind: helloKind,
    component: Hello,
  } satisfies SolidRenderer<HelloView> as unknown as SolidRenderer<never>);
