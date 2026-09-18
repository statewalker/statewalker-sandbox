import { type SolidRenderer, solidRenderersSlot } from "@b/shell/api/solid";
import { clearCompletedKind, todoEditorKind, todoListKind, todoRenameKind } from "@b/todos/api";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import type { Component } from "solid-js";
import { ClearCompletedDialog, TodoEditor, TodoList } from "./views.js";

/** `todos.ui.solid`: contributes the Todos renderers for Solid. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, component: Component<{ model: M }>) =>
    register(
      slots.register(solidRenderersSlot, kind.id, {
        kind,
        component,
      } satisfies SolidRenderer<M> as unknown as SolidRenderer<never>),
    );
  add(todoListKind, TodoList);
  add(todoEditorKind, TodoEditor);
  add(todoRenameKind, TodoEditor);
  add(clearCompletedKind, ClearCompletedDialog);
  return cleanup;
};
