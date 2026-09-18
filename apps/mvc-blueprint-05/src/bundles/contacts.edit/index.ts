/**
 * contacts.edit — the editor: seeded from the stored contact, Save commits the draft as it is at
 * the moment the Save message is processed, closes on success and notifies "Saved".
 */
import {
  type Activator,
  defineMsg,
  dispatchFx,
  disposers,
  getStore,
  next,
  useFields,
} from "../../kernel/index.ts";
import { shellMenu, shellNotify, shellPanels } from "../shell/api/index.ts";
import {
  type Contact,
  type ContactReply,
  type ContactUpdateEffect,
  contactEditorIntents,
  contactEditorKind,
  contactsCollection,
  contactsEditOpen,
  contactsSelection,
  contactsSelectionActions,
} from "../contacts/api/index.ts";

interface Session {
  readonly id: number;
  readonly contactId: string;
  readonly draft: Omit<Contact, "id">;
  readonly saving: boolean;
  readonly error?: string;
}
interface EditState {
  readonly session?: Session;
  readonly seq: number;
}
const editSelected = defineMsg("contacts.edit/edit-selected");
const save = defineMsg("contacts.edit/save");
const cancel = defineMsg("contacts.edit/cancel");
const SAVED = "contacts.edit/saved";

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);

  const slice = store.addSlice<EditState>({
    id: "contacts.edit",
    init: () => ({ seq: 0 }),
    update(state, msg, { select }) {
      const s = state.session;
      if (contactsEditOpen.match(msg) || editSelected.match(msg)) {
        const id = contactsEditOpen.match(msg)
          ? msg.id
          : select(contactsSelection)[0]?.selected?.id;
        const contact = select(contactsCollection)[0]?.contacts.find((c) => c.id === id);
        if (!contact) return state;
        const { id: contactId, ...draft } = contact;
        return {
          seq: state.seq + 1,
          session: { id: state.seq + 1, contactId, draft, saving: false },
        };
      }
      if (!s) return state;
      if (contactEditorIntents.field.match(msg)) {
        return { ...state, session: { ...s, draft: { ...s.draft, [msg.field]: msg.value } } };
      }
      if (cancel.match(msg)) return { ...state, session: undefined };
      if (save.match(msg)) {
        if (s.saving) return state; // refused visibly: Save shows running
        const fx: ContactUpdateEffect = {
          type: "contacts/update",
          id: s.contactId,
          patch: s.draft,
          reply: SAVED,
          ref: s.id,
        };
        return next({ ...state, session: { ...s, saving: true, error: undefined } }, fx);
      }
      if (msg.type === SAVED) {
        const reply = msg as ContactReply;
        if (reply.ref !== s.id) return state;
        if (reply.ok) {
          return next(
            { ...state, session: undefined },
            dispatchFx(shellNotify({ message: "Saved", tone: "success" })),
          );
        }
        return next(
          { ...state, session: { ...s, saving: false, error: reply.error } },
          dispatchFx(shellNotify({ message: `Save failed: ${reply.error}`, tone: "error" })),
        );
      }
      return state;
    },
  });

  return disposers(
    slice.contribute(shellPanels, "contacts.edit", (state, select) => {
      const s = state.session;
      if (!s) return [];
      const stored = select(contactsCollection)[0]?.contacts.find((c) => c.id === s.contactId);
      return [
        {
          id: "contacts.edit",
          kind: contactEditorKind,
          title: `Edit ${stored?.name ?? "contact"}`,
          placement: "side" as const,
          order: 30,
          props: {
            draft: s.draft,
            error: s.error,
            save: {
              id: "save",
              order: 10,
              label: "Save",
              enabled: !s.saving,
              running: s.saving,
              msg: save(),
            },
            cancel: { id: "cancel", order: 20, label: "Cancel", enabled: true, msg: cancel() },
          },
        },
      ];
    }),
    slice.contribute(contactsSelectionActions, "contacts.edit", (_state, select) => [
      {
        id: "edit",
        order: 10,
        label: "Edit",
        enabled: !!select(contactsSelection)[0]?.selected,
        msg: editSelected(),
      },
    ]),
    slice.contribute(shellMenu, "contacts.edit", (_state, select) => [
      {
        id: "contacts.edit",
        group: "contacts",
        groupLabel: "Contacts",
        order: 10,
        label: "Edit contact",
        enabled: !!select(contactsSelection)[0]?.selected,
        msg: editSelected(),
      },
    ]),
    slice.dispose,
  );
};
