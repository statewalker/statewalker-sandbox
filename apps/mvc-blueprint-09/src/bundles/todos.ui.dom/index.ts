import { type DomRenderer, domRenderersSlot } from "@b/shell/api/dom";
import { clearCompletedKind, todoEditorKind, todoListKind, todoRenameKind } from "@b/todos/api";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import { mountClearCompleted, mountTodoEditor, mountTodoList } from "./views.js";

/** `todos.ui.dom`: contributes the Todos renderers for plain DOM. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, mount: DomRenderer<M>["mount"]) =>
    register(
      slots.register(domRenderersSlot, kind.id, {
        kind,
        mount,
      } satisfies DomRenderer<M> as unknown as DomRenderer<never>),
    );
  add(todoListKind, mountTodoList);
  add(todoEditorKind, mountTodoEditor);
  add(todoRenameKind, mountTodoEditor);
  add(clearCompletedKind, mountClearCompleted);
  return cleanup;
};
