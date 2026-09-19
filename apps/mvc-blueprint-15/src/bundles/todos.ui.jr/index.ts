import { type JrView, jrViewsSlot } from "@b/shell/api/jr";
import { clearCompletedKind, todoEditorKind, todoListKind, todoRenameKind } from "@b/todos/api";
import { type Controller, getSlots, newRegistry } from "@kernel";
import { confirm, titleForm, todoList } from "./bindings.js";
import confirmSpec from "./confirm.json";
import listSpec from "./list.json";
import titleFormSpec from "./title-form.json";

/** `todos.ui.jr`: the Todos views as json-render specs, for every technology. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(view: JrView<M>) =>
    register(slots.register(jrViewsSlot, view.kind.id, view as unknown as JrView<never>));
  add({ kind: todoListKind, spec: listSpec, bind: todoList });
  add({ kind: todoEditorKind, spec: titleFormSpec, bind: titleForm });
  add({ kind: todoRenameKind, spec: titleFormSpec, bind: titleForm });
  add({ kind: clearCompletedKind, spec: confirmSpec, bind: confirm });
  return cleanup;
};
