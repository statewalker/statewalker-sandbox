import type {
  Contact,
  ContactDetailsView,
  ContactListView,
  ContactSelectionView,
} from "@b/contacts/api";
import { type ActionContribution, type ActionControl, type ActionView, readable } from "@kernel";
import { createAction, newChannels, sameRecords, stableGroup } from "@kit/model";
import { signal, untracked } from "@kit/signals";

export interface ContactListModel {
  readonly view: ContactListView;
  /** Published to `contacts:selection` (P4: a `Readable` on the shared substrate). */
  readonly selection: ContactSelectionView;
  /** The details panel's model (the model contract, for renderers). */
  readonly details: ContactDetailsView;
  readonly edit: { readonly view: ActionView; readonly control: ActionControl };
  readonly editFromMenu: { readonly view: ActionView; readonly control: ActionControl };
  readonly control: {
    publishContacts(contacts: readonly Contact[]): void;
    publishSelectionActions(items: readonly ActionContribution[]): void;
  };
  dispose(): void;
}

const EMPTY: readonly never[] = Object.freeze([]);

export function createContactListModel(): ContactListModel {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const alive = signal(true);
  const contacts = signal<readonly Contact[]>(EMPTY);
  const rawSelected = signal<string | undefined>(undefined);
  const selectionActions = signal<readonly ActionContribution[]>(EMPTY);

  // Derived: the selected contact as stored now (details follow a save); gone ⇒ nothing selected.
  const selected = stableGroup((): Contact | undefined => {
    const all = contacts();
    const id = rawSelected();
    return all.find((c) => c.id === id);
  });
  const selectedId = stableGroup((): string | undefined => selected()?.id);
  const guard = () => {
    const live = alive();
    const has = selected() !== undefined;
    return live && has;
  };
  const edit = createAction({ label: "Edit", when: guard });
  const editFromMenu = createAction({ label: "Edit contact", when: guard });

  const view: ContactListView = Object.freeze({
    getContacts: () => contacts(),
    onContactsUpdate: channels.channel(contacts),
    getSelectedId: () => selectedId(),
    onSelectedIdUpdate: channels.channel(selectedId),
    select: (id: string | undefined) => {
      if (!disposed) rawSelected(id);
    },
    getSelectionActions: () => selectionActions(),
    onSelectionActionsUpdate: channels.channel(selectionActions),
  });
  const selection: ContactSelectionView = Object.freeze({
    selected: readable(selected, () => !disposed),
  });
  const details: ContactDetailsView = Object.freeze({
    getContact: () => selected(),
    onContactUpdate: channels.channel(selected),
  });
  return Object.freeze({
    view,
    selection,
    details,
    edit,
    editFromMenu,
    control: Object.freeze({
      publishContacts: (next: readonly Contact[]) => {
        if (
          !disposed &&
          !sameRecords(
            untracked(() => contacts()),
            next,
          )
        ) {
          contacts(Object.freeze([...next]));
        }
      },
      publishSelectionActions: (next: readonly ActionContribution[]) => {
        if (
          !disposed &&
          !sameRecords(
            untracked(() => selectionActions()),
            next,
          )
        ) {
          selectionActions(Object.freeze([...next]));
        }
      },
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      alive(false);
      edit.dispose();
      editFromMenu.dispose();
      channels.dispose();
    },
  });
}
