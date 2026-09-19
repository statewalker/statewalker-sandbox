import { type Context, getSlots, type Scope } from "@p5/kernel";
import { helloKind } from "@p5/hello/api";
import { solidRenderer } from "@p5/kit-solid";
import { solidRenderersSlot } from "@p5/shell/api/solid";
import { Hello } from "./view.js";

/** `hello.ui.solid`: the hello panel's Solid renderer. */
export default async function helloUiSolid(context: Context, scope: Scope) {
  scope.defer(
    getSlots(context).register(solidRenderersSlot, helloKind.id, solidRenderer(helloKind, Hello)),
  );
}
