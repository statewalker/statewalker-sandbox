/** Contacts API — declarations only. */
import {
  type ActionItem,
  defineMsg,
  definePoint,
  defineViewKind,
  type Effect,
  type Msg,
} from "../../../kernel/index.ts";

export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
}
export type ContactPatch = Partial<Omit<Contact, "id">>;
export interface ContactApi {
  list(): Promise<Contact[]>;
  get(id: string): Promise<Contact | undefined>;
  /** Rejects when `name` is empty after trimming. */
  update(id: string, patch: ContactPatch): Promise<Contact>;
}
export const CONTACT_API_KEY = "contacts:api";

// ---- points ------------------------------------------------------------------------------------
/** One contribution, owner `contacts.core`. (R1 addition: P0's list reads the service instead.) */
export const contactsCollection = definePoint<{ readonly contacts: readonly Contact[] }>(
  "contacts:collection",
);
/** One contribution, owner `contacts.list`. */
export const contactsSelection = definePoint<{ readonly selected: Contact | undefined }>(
  "contacts:selection",
);
/** Edit, and anything another app contributes. */
export const contactsSelectionActions = definePoint<ActionItem>("contacts:selection-actions");

// ---- public messages ---------------------------------------------------------------------------
export const contactsEditOpen = defineMsg<{ id: string }>("contacts/edit-open");

// ---- the api effect (performed by `contacts.core`) ---------------------------------------------
export interface ContactUpdateEffect extends Effect {
  readonly type: "contacts/update";
  readonly id: string;
  readonly patch: ContactPatch;
  readonly reply: string;
  readonly ref: number;
}
export interface ContactReply extends Msg {
  readonly ref: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly id: string;
  readonly patch: ContactPatch;
}

// ---- view kinds and intents --------------------------------------------------------------------
export interface ContactsListProps {
  readonly rows: readonly {
    readonly id: string;
    readonly name: string;
    readonly selected: boolean;
  }[];
  readonly selectionActions: readonly ActionItem[];
}
export interface ContactDetailsProps {
  readonly contact: Contact;
}
export interface ContactEditorProps {
  readonly draft: Omit<Contact, "id">;
  readonly error?: string;
  readonly save: ActionItem;
  readonly cancel: ActionItem;
}
export const contactsListKind = defineViewKind<ContactsListProps>("contacts:list");
export const contactDetailsKind = defineViewKind<ContactDetailsProps>("contacts:details");
export const contactEditorKind = defineViewKind<ContactEditorProps>("contacts:editor");

export const contactsListIntents = {
  select: defineMsg<{ id: string }>("contacts.list/select"),
};
export const contactEditorIntents = {
  field: defineMsg<{ field: keyof Omit<Contact, "id">; value: string }>("contacts.edit/field"),
};
