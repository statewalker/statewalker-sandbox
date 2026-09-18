/** hello — the minimal bundle of §13.1: a menu item, a panel, a counter. Kernel only. */
import { type Activator, disposers, getStore } from "../../kernel/index.ts";
import { shellMenu, shellPanels } from "../shell/api/index.ts";
import { helloKind } from "./api/index.ts";

const open = { type: "hello/open" };
const increment = { type: "hello/increment" };

export const activate: Activator = async (context) => {
  const slice = getStore(context).addSlice({
    id: "hello",
    init: () => ({ count: 0, open: false }),
    update: (s, msg) =>
      msg.type === open.type
        ? { ...s, open: true }
        : msg.type === increment.type
          ? { ...s, count: s.count + 1 }
          : s,
  });
  return disposers(
    slice.contribute(shellMenu, "hello", () => [
      {
        id: "hello",
        group: "hello",
        groupLabel: "Hello",
        order: 0,
        label: "Say hello",
        enabled: true,
        msg: open,
      },
    ]),
    slice.contribute(shellPanels, "hello", (s) =>
      s.open
        ? [
            {
              id: "hello",
              kind: helloKind,
              title: "Hello",
              placement: "main" as const,
              props: {
                count: s.count,
                increment: {
                  id: "inc",
                  order: 0,
                  label: "Increment",
                  enabled: true,
                  msg: increment,
                },
              },
            },
          ]
        : [],
    ),
    slice.dispose,
  );
};
