import { helloKind } from "@b/hello/api";
import { reactRenderersSlot } from "@b/shell/api/react";
import { type Controller, getSlots } from "@kernel";
import { Hello } from "./view.js";

/** `hello.ui.react`: the hello panel's React renderer. */
export const activate: Controller = async (context) =>
  getSlots(context).register(reactRenderersSlot, helloKind.id, {
    kind: helloKind,
    component: Hello,
  } as never);
