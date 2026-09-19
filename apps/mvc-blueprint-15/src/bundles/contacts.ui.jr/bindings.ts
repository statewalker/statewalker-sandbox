import type { ContactDetailsView, ContactEditorView, ContactListView } from "@b/contacts/api";
import type { ModelBinding } from "@kit/jr";

/** The Contacts view models as json-render state. */

export const contactList = (m: ContactListView): ModelBinding => ({
  values: {
    contacts: [m.getContacts, m.onContactsUpdate],
    selectedId: [m.getSelectedId, m.onSelectedIdUpdate],
  },
  actionLists: { selectionActions: [m.getSelectionActions, m.onSelectionActionsUpdate] },
  intents: { select: ({ id }) => m.select(String(id)) },
});

export const contactDetails = (m: ContactDetailsView): ModelBinding => ({
  values: { contact: [m.getContact, m.onContactUpdate] },
});

export const contactEditor = (m: ContactEditorView): ModelBinding => ({
  values: { draft: [m.getDraft, m.onDraftUpdate], status: [m.getStatus, m.onStatusUpdate] },
  actions: { save: m.save, cancel: m.cancel },
  writes: {
    "/draft/name": (v) => m.editField("name", String(v)),
    "/draft/email": (v) => m.editField("email", String(v)),
    "/draft/phone": (v) => m.editField("phone", String(v)),
  },
});
