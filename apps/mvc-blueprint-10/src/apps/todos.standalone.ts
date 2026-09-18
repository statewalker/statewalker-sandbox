import type { ApplicationManifest } from "@kernel";
import { shellTestFeature, todosDom } from "../features/dom.js";
import { todos, todosStatusFeature } from "../features/logic.js";

/** Todos alone, in the trivial test shell. No Contacts code is loaded. */
export const todosStandalone: ApplicationManifest = {
  id: "todos.standalone",
  features: [shellTestFeature, todos, todosStatusFeature, todosDom],
};
