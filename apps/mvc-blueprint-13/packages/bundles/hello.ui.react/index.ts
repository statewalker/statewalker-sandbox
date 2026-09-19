import { type Controller, getSlots } from "@p5/kernel";
import { helloKind } from "@p5/hello/api";
import { reactRenderer } from "@p5/kit-react";
import { reactRenderersSlot } from "@p5/shell/api/react";
import { Hello } from "./view.js";

/** `hello.ui.react`: the hello panel's React renderer. */
export const activate: Controller = async (context, scope) => {
  scope.defer(
    getSlots(context).register(reactRenderersSlot, helloKind.id, reactRenderer(helloKind, Hello)),
  );
};
