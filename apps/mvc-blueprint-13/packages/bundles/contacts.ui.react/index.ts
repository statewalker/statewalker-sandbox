import { contactDetailsKind, contactEditorKind, contactListKind } from "@p5/contacts/api";
import { type Controller, getSlots } from "@p5/kernel";
import { reactRenderer } from "@p5/kit-react";
import { reactRenderersSlot } from "@p5/shell/api/react";
import { ContactDetails, ContactEditor, ContactList } from "./views.js";

/** `contacts.ui.react`: contributes the Contacts renderers for React. Wiring only. */
export const activate: Controller = async (context, scope) => {
  const slots = getSlots(context);
  for (const r of [
    reactRenderer(contactListKind, ContactList),
    reactRenderer(contactDetailsKind, ContactDetails),
    reactRenderer(contactEditorKind, ContactEditor),
  ])
    scope.defer(slots.register(reactRenderersSlot, r.kind.id, r));
};
