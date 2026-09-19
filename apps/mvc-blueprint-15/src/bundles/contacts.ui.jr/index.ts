import { contactDetailsKind, contactEditorKind, contactListKind } from "@b/contacts/api";
import { type JrView, jrViewsSlot } from "@b/shell/api/jr";
import { type Controller, getSlots, newRegistry } from "@kernel";
import { contactDetails, contactEditor, contactList } from "./bindings.js";
import detailsSpec from "./details.json";
import editorSpec from "./editor.json";
import listSpec from "./list.json";

/** `contacts.ui.jr`: the Contacts views as json-render specs, for every technology. Wiring only. */
export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  const add = <M>(view: JrView<M>) =>
    register(slots.register(jrViewsSlot, view.kind.id, view as unknown as JrView<never>));
  add({ kind: contactListKind, spec: listSpec, bind: contactList });
  add({ kind: contactDetailsKind, spec: detailsSpec, bind: contactDetails });
  add({ kind: contactEditorKind, spec: editorSpec, bind: contactEditor });
  return cleanup;
};
