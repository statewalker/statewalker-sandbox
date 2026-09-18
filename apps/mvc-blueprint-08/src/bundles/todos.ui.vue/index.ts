import { type VueRenderer, vueRenderersSlot } from "@b/shell/api/vue";
import { clearCompletedKind, todoEditorKind, todoListKind, todoRenameKind } from "@b/todos/api";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import type { Component } from "vue";
import { ClearCompletedDialog, TodoEditor, TodoList } from "./views.js";

/** `todos.ui.vue`: contributes the Todos renderers for Vue. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, component: Component<{ model: M }>) =>
    register(
      slots.register(vueRenderersSlot, kind.id, {
        kind,
        component,
      } satisfies VueRenderer<M> as unknown as VueRenderer<never>),
    );
  add(todoListKind, TodoList);
  add(todoEditorKind, TodoEditor);
  add(todoRenameKind, TodoEditor);
  add(clearCompletedKind, ClearCompletedDialog);
  return cleanup;
};
