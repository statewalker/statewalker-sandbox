import { type Context, getSlots, type Scope } from "@p5/kernel";
import { reactRenderer } from "@p5/kit-react";
import { reactRenderersSlot } from "@p5/shell/api/react";
import { clearCompletedKind, todoEditorKind, todoListKind, todoRenameKind } from "@p5/todos/api";
import { ClearCompletedDialog, TodoEditor, TodoList } from "./views.js";

/** `todos.ui.react`: contributes the Todos renderers for React. Wiring only. */
export default async function todosUiReact(context: Context, scope: Scope) {
  const slots = getSlots(context);
  for (const r of [
    reactRenderer(todoListKind, TodoList),
    reactRenderer(todoEditorKind, TodoEditor),
    reactRenderer(todoRenameKind, TodoEditor),
    reactRenderer(clearCompletedKind, ClearCompletedDialog),
  ])
    scope.defer(slots.register(reactRenderersSlot, r.kind.id, r));
}
