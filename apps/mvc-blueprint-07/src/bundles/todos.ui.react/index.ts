import type { Controller } from "../../kernel/context.js";
import { getSlots } from "../../kernel/slots.js";
import { reactRenderer, reactRenderersSlot } from "../shell/api/react.js";
import { clearCompletedKind, todoEditorKind, todosListKind } from "../todos/api/index.js";
import { ClearCompletedConfirm } from "./confirm.js";
import { TodoEditor } from "./editor.js";
import { TodoList } from "./list.js";

/** The UI bundle's activator only contributes renderers — wiring, not runtime publication. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const offs = [
    slots.register(reactRenderersSlot, todosListKind.id, reactRenderer(todosListKind, TodoList)),
    slots.register(
      reactRenderersSlot,
      todoEditorKind.id,
      reactRenderer(todoEditorKind, TodoEditor),
    ),
    slots.register(
      reactRenderersSlot,
      clearCompletedKind.id,
      reactRenderer(clearCompletedKind, ClearCompletedConfirm),
    ),
  ];
  return () => {
    for (const off of offs) off();
  };
};
