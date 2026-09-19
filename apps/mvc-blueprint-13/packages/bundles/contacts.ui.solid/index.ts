import { contactDetailsKind, contactEditorKind, contactListKind } from "@p5/contacts/api";
import { type Controller, getSlots } from "@p5/kernel";
import { solidRenderer } from "@p5/kit-solid";
import { solidRenderersSlot } from "@p5/shell/api/solid";
import { ContactDetails, ContactEditor, ContactList } from "./views.js";

/** `contacts.ui.solid`: contributes the Contacts renderers for Solid. Wiring only. */
export const activate: Controller = async (context, scope) => {
  const slots = getSlots(context);
  for (const r of [
    solidRenderer(contactListKind, ContactList),
    solidRenderer(contactDetailsKind, ContactDetails),
    solidRenderer(contactEditorKind, ContactEditor),
  ])
    scope.defer(slots.register(solidRenderersSlot, r.kind.id, r));
};
