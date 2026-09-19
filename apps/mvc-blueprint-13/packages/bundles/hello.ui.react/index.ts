import { helloKind } from "@p5/hello/api";
import { reactRenderersSlot } from "@p5/shell/api/react";
import { type Controller, getSlots } from "@p5/kernel";
import { Hello } from "./view.js";

/** `hello.ui.react`: the hello panel's React renderer. */
export const activate: Controller = async (context) =>
  getSlots(context).register(reactRenderersSlot, helloKind.id, {
    kind: helloKind,
    component: Hello,
  } as never);
