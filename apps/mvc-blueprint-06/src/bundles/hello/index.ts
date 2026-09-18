/** The minimal bundle (§13.1): one menu item, one panel, one action that increments a counter. Kernel only. */
import {
  type ActionDesc,
  type BundleManifest,
  contribute,
  defineStream,
} from "../../kernel/index.js";
import { menu, panels } from "../shell/api/index.js";
import { type HelloState, helloKind } from "./api/index.js";

const view = defineStream<HelloState>("hello:view");
const increment: ActionDesc = {
  id: "increment",
  label: "Increment",
  enabled: true,
  to: "hello",
  msg: "increment",
};

export const helloBundle: BundleManifest = {
  id: "hello",
  behavior: (ctx) => {
    let count = 0;
    ctx.publish(view, { count, increment });
    contribute(ctx, menu, "hello:increment", {
      group: "hello",
      groupLabel: "Hello",
      order: 0,
      action: increment,
    });
    contribute(ctx, panels, "hello", {
      kind: helloKind.id,
      stream: view,
      inbox: "hello",
      title: "Hello",
      placement: "main",
    });
    return () => ctx.publish(view, { count: ++count, increment });
  },
};
