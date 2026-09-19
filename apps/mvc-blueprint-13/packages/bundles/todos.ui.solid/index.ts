import { type Context, getSlots, type Scope } from "@p5/kernel";
import { solidRenderer } from "@p5/kit-solid";
import { solidRenderersSlot } from "@p5/shell/api/solid";
import { clearCompletedKind, todoEditorKind, todoListKind, todoRenameKind } from "@p5/todos/api";
import { ClearCompletedDialog, TodoEditor, TodoList } from "./views.js";

/** `todos.ui.solid`: contributes the Todos renderers for Solid. Wiring only. */
export default async function todosUiSolid(context: Context, scope: Scope) {
  const slots = getSlots(context);
  for (const r of [
    solidRenderer(todoListKind, TodoList),
    solidRenderer(todoEditorKind, TodoEditor),
    solidRenderer(todoRenameKind, TodoEditor),
    solidRenderer(clearCompletedKind, ClearCompletedDialog),
  ])
    scope.defer(slots.register(solidRenderersSlot, r.kind.id, r));
}
