import { type HelloView, helloKind } from "@b/hello/api";
import { type AnySpecContribution, type SpecContribution, viewSpecsSlot } from "@b/shell/api/spec";
import { type Controller, getSlots } from "@kernel";
import { helloSpec } from "./spec.js";

/** `hello.ui.spec`: the hello panel as a spec. */
export const activate: Controller = async (context) =>
  getSlots(context).register(viewSpecsSlot, helloKind.id, {
    kind: helloKind,
    spec: helloSpec,
  } satisfies SpecContribution<HelloView> as unknown as AnySpecContribution);
