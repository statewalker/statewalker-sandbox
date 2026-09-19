import { type HelloView, helloKind } from "@b/hello/api";
import { type JrView, jrViewsSlot } from "@b/shell/api/jr";
import { type Controller, getSlots } from "@kernel";
import spec from "./hello.json";

const view: JrView<HelloView> = {
  kind: helloKind,
  spec,
  bind: (m) => ({
    values: { count: [m.getCount, m.onCountUpdate] },
    actions: { increment: m.increment },
  }),
};

/** `hello.ui.jr`: the hello panel as a json-render spec, for every technology. */
export const activate: Controller = async (context) =>
  getSlots(context).register(jrViewsSlot, helloKind.id, view as unknown as JrView<never>);
