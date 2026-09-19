import { type AnySpecContribution, type SpecContribution, viewSpecsSlot } from "@b/shell/api/spec";
import { clearCompletedKind, todoEditorKind, todoListKind, todoRenameKind } from "@b/todos/api";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import { clearCompletedSpec, titleFormSpec, todoListSpec } from "./specs.js";

/** `todos.ui.spec`: contributes the Todos views as specs, for every interpreter. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, spec: SpecContribution<M>["spec"]) =>
    register(
      slots.register(viewSpecsSlot, kind.id, {
        kind,
        spec,
      } satisfies SpecContribution<M> as unknown as AnySpecContribution),
    );
  add(todoListKind, todoListSpec);
  add(todoEditorKind, titleFormSpec);
  add(todoRenameKind, titleFormSpec);
  add(clearCompletedKind, clearCompletedSpec);
  return cleanup;
};
