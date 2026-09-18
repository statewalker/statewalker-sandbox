import { type ReactRenderer, reactRenderersSlot } from "@b/shell/api/react";
import { clearCompletedKind, todoEditorKind, todoListKind } from "@b/todos/api";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import type { ComponentType } from "react";
import { ClearCompletedDialog, TodoEditor, TodoList } from "./views.js";

/** `todos.ui.react`: contributes the Todos renderers for React. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, component: ComponentType<{ model: M }>) =>
    register(
      slots.register(reactRenderersSlot, kind.id, {
        kind,
        component,
      } satisfies ReactRenderer<M> as unknown as ReactRenderer<never>),
    );
  add(todoListKind, TodoList);
  add(todoEditorKind, TodoEditor);
  add(clearCompletedKind, ClearCompletedDialog);
  return cleanup;
};
