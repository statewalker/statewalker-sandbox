import type { HelloView } from "@b/hello/api";
import type { ViewSpec } from "@b/shell/api/spec";

export const helloSpec: ViewSpec<HelloView> = {
  root: {
    el: "div",
    attrs: { class: "flex items-center gap-3" },
    children: [
      {
        el: "p",
        attrs: { "data-hello-count": true },
        children: [{ text: { concat: ["Count: ", { read: "count" }] } }],
      },
      { action: "increment" },
    ],
  },
};
