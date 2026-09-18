import { contactDetailsKind, contactEditorKind, contactListKind } from "@b/contacts/api";
import { type SvelteRenderer, svelteRenderersSlot } from "@b/shell/api/svelte";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import type { Component } from "svelte";
import ContactDetails from "./ContactDetails.svelte";
import ContactEditor from "./ContactEditor.svelte";
import ContactList from "./ContactList.svelte";

/** `contacts.ui.svelte`: contributes the Contacts renderers for Svelte. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, component: Component<{ model: M }>) =>
    register(
      slots.register(svelteRenderersSlot, kind.id, {
        kind,
        component,
      } satisfies SvelteRenderer<M> as unknown as SvelteRenderer<never>),
    );
  add(contactListKind, ContactList);
  add(contactDetailsKind, ContactDetails);
  add(contactEditorKind, ContactEditor);
  return cleanup;
};
