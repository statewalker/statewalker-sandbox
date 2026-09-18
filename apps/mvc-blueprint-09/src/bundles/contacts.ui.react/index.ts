import { contactDetailsKind, contactEditorKind, contactListKind } from "@b/contacts/api";
import { type ReactRenderer, reactRenderersSlot } from "@b/shell/api/react";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import type { ComponentType } from "react";
import { ContactDetails, ContactEditor, ContactList } from "./views.js";

/** `contacts.ui.react`: contributes the Contacts renderers for React. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, component: ComponentType<{ model: M }>) =>
    register(
      slots.register(reactRenderersSlot, kind.id, {
        kind,
        component,
      } satisfies ReactRenderer<M> as unknown as ReactRenderer<never>),
    );
  add(contactListKind, ContactList);
  add(contactDetailsKind, ContactDetails);
  add(contactEditorKind, ContactEditor);
  return cleanup;
};
