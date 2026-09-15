import { todoListKind } from "@todos/list/model";
import { type ReactRenderer, reactRenderer } from "@ui/host";
import { TodoListPanel } from "./list-view.js";

export { TodoListPanel };
export const todoListRenderers: readonly ReactRenderer[] = [
  reactRenderer(todoListKind, TodoListPanel),
];
