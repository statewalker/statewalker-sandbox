/** todos.ui.react — contributes the Todos renderers. Wiring only. */
import { type Activator, disposers, getStore, useFields } from "../../kernel/index.ts";
import { reactRenderers, renderer } from "../shell/api/react.ts";
import {
  clearCompletedKind,
  renameTodoKind,
  todoEditorKind,
  todosListKind,
} from "../todos/api/index.ts";
import { ClearCompleted, RenameTodo, TodoEditor, TodosList } from "./views.tsx";

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);
  const add = (r: ReturnType<typeof renderer>) =>
    store.contribute(reactRenderers, r.kind.id, () => [r]);
  return disposers(
    add(renderer(todosListKind, TodosList)),
    add(renderer(todoEditorKind, TodoEditor)),
    add(renderer(clearCompletedKind, ClearCompleted)),
    add(renderer(renameTodoKind, RenameTodo)),
  );
};
