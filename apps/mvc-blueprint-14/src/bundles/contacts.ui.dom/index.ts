import { contactDetailsKind, contactEditorKind, contactListKind } from "@b/contacts/api";
import { type DomRenderer, domRenderersSlot } from "@b/shell/api/dom";
import { type Controller, getSlots, newRegistry, type ViewKind } from "@kernel";
import { mountContactDetails, mountContactEditor, mountContactList } from "./views.js";

/** `contacts.ui.dom`: contributes the Contacts renderers for plain DOM. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(kind: ViewKind<M>, mount: DomRenderer<M>["mount"]) =>
    register(
      slots.register(domRenderersSlot, kind.id, {
        kind,
        mount,
      } satisfies DomRenderer<M> as unknown as DomRenderer<never>),
    );
  add(contactListKind, mountContactList);
  add(contactDetailsKind, mountContactDetails);
  add(contactEditorKind, mountContactEditor);
  return cleanup;
};
