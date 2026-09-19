import { contactDetailsKind, contactEditorKind, contactListKind } from "@b/contacts/api";
import { type AnySpecContribution, type SpecContribution, viewSpecsSlot } from "@b/shell/api/spec";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import { contactDetailsSpec, contactEditorSpec, contactListSpec } from "./specs.js";

/** `contacts.ui.spec`: contributes the Contacts views as specs, for every interpreter. Wiring only. */
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
  add(contactListKind, contactListSpec);
  add(contactDetailsKind, contactDetailsSpec);
  add(contactEditorKind, contactEditorSpec);
  return cleanup;
};
