import type {
  Contact,
  ContactDetailsView,
  ContactListView,
  ContactSelectionView,
} from "@p5/contacts/api";
import type { ActionContribution } from "@p5/kernel";
import { type CommitActionModel, createCommitAction } from "@p5/kit-commit";
import { newChannels, sameRecords, stableGroup } from "@p5/kit-model";
import { readable, signal, untracked } from "@p5/kit-signals";

export interface ContactListModel {
  readonly view: ContactListView;
  /** Published to `contacts:selection`; also the details panel's model. */
  readonly selection: ContactSelectionView & ContactDetailsView;
  /** Records carry the id selected at submit. */
  readonly edit: Omit<CommitActionModel<string>, "dispose">;
  readonly editFromMenu: Omit<CommitActionModel<string>, "dispose">;
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
  const capture = () => selected()?.id as string;
  const edit = createCommitAction({ label: "Edit", when: guard, capture });
  const editFromMenu = createCommitAction({ label: "Edit contact", when: guard, capture });

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
  const onSelected = channels.channel(selected);
  const selection = Object.freeze({
    getSelected: readable(selected),
    onSelectedUpdate: onSelected,
    getContact: () => selected(),
    onContactUpdate: onSelected,
  });
  return Object.freeze({
    view,
    selection,
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
