/** contacts.ui.react — contributes the Contacts renderers. */
import { type Activator, disposers, getStore, useFields } from "../../kernel/index.ts";
import { contactDetailsKind, contactEditorKind, contactsListKind } from "../contacts/api/index.ts";
import { reactRenderers, renderer } from "../shell/api/react.ts";
import { ContactDetails, ContactEditor, ContactsList } from "./views.tsx";

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);
  const add = (r: ReturnType<typeof renderer>) =>
    store.contribute(reactRenderers, r.kind.id, () => [r]);
  return disposers(
    add(renderer(contactsListKind, ContactsList)),
    add(renderer(contactDetailsKind, ContactDetails)),
    add(renderer(contactEditorKind, ContactEditor)),
  );
};
