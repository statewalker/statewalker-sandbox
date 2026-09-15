import { todoEditKind } from "@todos/edit/model";
import { type ReactRenderer, reactRenderer } from "@ui/host";
import { TodoEditPanel } from "./edit-view.js";

export { TodoEditPanel };
export const todoEditRenderers: readonly ReactRenderer[] = [
  reactRenderer(todoEditKind, TodoEditPanel),
];
