import { contactDetailsKind, contactEditorKind, contactListKind } from "@b/contacts/api";
import { type SolidRenderer, solidRenderersSlot } from "@b/shell/api/solid";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import type { Component } from "solid-js";
import { ContactDetails, ContactEditor, ContactList } from "./views.js";

/** `contacts.ui.solid`: contributes the Contacts renderers for Solid. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, component: Component<{ model: M }>) =>
    register(
      slots.register(solidRenderersSlot, kind.id, {
        kind,
        component,
      } satisfies SolidRenderer<M> as unknown as SolidRenderer<never>),
    );
  add(contactListKind, ContactList);
  add(contactDetailsKind, ContactDetails);
  add(contactEditorKind, ContactEditor);
  return cleanup;
};
