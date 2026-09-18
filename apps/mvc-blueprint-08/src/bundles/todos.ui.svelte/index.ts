import { type SvelteRenderer, svelteRenderersSlot } from "@b/shell/api/svelte";
import { clearCompletedKind, todoEditorKind, todoListKind, todoRenameKind } from "@b/todos/api";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import type { Component } from "svelte";
import ClearCompletedDialog from "./ClearCompletedDialog.svelte";
import TodoEditor from "./TodoEditor.svelte";
import TodoList from "./TodoList.svelte";

/** `todos.ui.svelte`: contributes the Todos renderers for Svelte. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, component: Component<{ model: M }>) =>
    register(
      slots.register(svelteRenderersSlot, kind.id, {
        kind,
        component,
      } satisfies SvelteRenderer<M> as unknown as SvelteRenderer<never>),
    );
  add(todoListKind, TodoList);
  add(todoEditorKind, TodoEditor);
  add(todoRenameKind, TodoEditor);
  add(clearCompletedKind, ClearCompletedDialog);
  return cleanup;
};
