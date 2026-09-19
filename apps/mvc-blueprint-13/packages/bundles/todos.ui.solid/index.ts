import { type Controller, getSlots } from "@p5/kernel";
import { solidRenderer } from "@p5/kit-solid";
import { solidRenderersSlot } from "@p5/shell/api/solid";
import { clearCompletedKind, todoEditorKind, todoListKind } from "@p5/todos/api";
import { ClearCompletedDialog, TodoEditor, TodoList } from "./views.js";

/** `todos.ui.solid`: contributes the Todos renderers for Solid. Wiring only. */
export const activate: Controller = async (context, scope) => {
  const slots = getSlots(context);
  for (const r of [
    solidRenderer(todoListKind, TodoList),
    solidRenderer(todoEditorKind, TodoEditor),
    solidRenderer(clearCompletedKind, ClearCompletedDialog),
  ])
    scope.defer(slots.register(solidRenderersSlot, r.kind.id, r));
};
