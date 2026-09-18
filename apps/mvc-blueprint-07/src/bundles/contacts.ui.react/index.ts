import type { Controller } from "../../kernel/context.js";
import { getSlots } from "../../kernel/slots.js";
import { contactDetailsKind, contactEditorKind, contactsListKind } from "../contacts/api/index.js";
import { reactRenderer, reactRenderersSlot } from "../shell/api/react.js";
import { ContactDetails, ContactEditor, ContactList } from "./views.js";

export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const offs = [
    slots.register(
      reactRenderersSlot,
      contactsListKind.id,
      reactRenderer(contactsListKind, ContactList),
    ),
    slots.register(
      reactRenderersSlot,
      contactDetailsKind.id,
      reactRenderer(contactDetailsKind, ContactDetails),
    ),
    slots.register(
      reactRenderersSlot,
      contactEditorKind.id,
      reactRenderer(contactEditorKind, ContactEditor),
    ),
  ];
  return () => {
    for (const off of offs) off();
  };
};
