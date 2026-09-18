/** contacts.list — the list panel, the selection, and the details side panel. */
import {
  type ActionItem,
  type Activator,
  disposers,
  getStore,
  useFields,
} from "../../kernel/index.ts";
import {
  type Contact,
  contactDetailsKind,
  contactsCollection,
  contactsListIntents,
  contactsListKind,
  contactsSelection,
  contactsSelectionActions,
} from "../contacts/api/index.ts";
import { shellPanels } from "../shell/api/index.ts";

interface ListState {
  readonly selectedId?: string;
}

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);
  const { select: selectIntent } = contactsListIntents;

  const slice = store.addSlice<ListState>({
    id: "contacts.list",
    init: () => ({}),
    update: (state, msg) =>
      selectIntent.match(msg) && msg.id !== state.selectedId ? { selectedId: msg.id } : state,
  });
  const selected = (state: ListState, contacts: readonly Contact[]) =>
    contacts.find((c) => c.id === state.selectedId);

  return disposers(
    slice.contribute(contactsSelection, "contacts.list", (state, select) => [
      { selected: selected(state, select(contactsCollection)[0]?.contacts ?? []) },
    ]),
    slice.contribute(shellPanels, "contacts.list", (state, select) => {
      const collection = select(contactsCollection)[0];
      if (!collection) return [];
      const contact = selected(state, collection.contacts);
      const byOrder = (a: ActionItem, b: ActionItem) =>
        a.order - b.order || a.id.localeCompare(b.id);
      const list = {
        id: "contacts.list",
        kind: contactsListKind,
        title: "Contacts",
        placement: "main" as const,
        order: 20,
        props: {
          rows: collection.contacts.map((c) => ({
            id: c.id,
            name: c.name,
            selected: c.id === contact?.id,
          })),
          selectionActions: [...select(contactsSelectionActions)].sort(byOrder),
        },
      };
      if (!contact) return [list];
      return [
        list,
        {
          id: "contacts.details",
          kind: contactDetailsKind,
          title: contact.name,
          placement: "side" as const,
          order: 20,
          props: { contact },
        },
      ];
    }),
    slice.dispose,
  );
};
