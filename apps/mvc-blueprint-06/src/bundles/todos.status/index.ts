/** `todos.status` — the header item "N open todos", derived from `todos:collection` only. */
import {
  type Behavior,
  type BundleManifest,
  type Contributed,
  contribute,
} from "../../kernel/index.js";
import { type HeaderItem, header } from "../shell/api/index.js";
import { collection } from "../todos/api/index.js";

const behavior: Behavior<unknown> = (ctx) => {
  let item: Contributed<HeaderItem> | undefined;
  ctx.subscribe(collection, (c) => {
    if (!c) {
      item?.withdraw();
      item = undefined;
      return;
    }
    const value = { order: 10, text: `${c.counts.open} open todos` };
    if (item) item.update(value);
    else item = contribute(ctx, header, "todos.status", value);
  });
  return () => {};
};

export const todosStatusBundle: BundleManifest = { id: "todos.status", behavior };
