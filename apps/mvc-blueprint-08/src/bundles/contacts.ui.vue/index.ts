import { contactDetailsKind, contactEditorKind, contactListKind } from "@b/contacts/api";
import { type VueRenderer, vueRenderersSlot } from "@b/shell/api/vue";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import type { Component } from "vue";
import { ContactDetails, ContactEditor, ContactList } from "./views.js";

/** `contacts.ui.vue`: contributes the Contacts renderers for Vue. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, component: Component<{ model: M }>) =>
    register(
      slots.register(vueRenderersSlot, kind.id, {
        kind,
        component,
      } satisfies VueRenderer<M> as unknown as VueRenderer<never>),
    );
  add(contactListKind, ContactList);
  add(contactDetailsKind, ContactDetails);
  add(contactEditorKind, ContactEditor);
  return cleanup;
};
