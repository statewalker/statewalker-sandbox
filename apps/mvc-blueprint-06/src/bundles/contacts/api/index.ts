/** Contacts API — declarations only. */
import {
  type ActionDesc,
  type ActionItem,
  type Asks,
  defineAddress,
  definePoint,
  defineStream,
  defineViewKind,
} from "../../../kernel/index.js";

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

// --- contacts.core: owns the api and the directory ---------------------------------------------
export type ContactsCoreMsg = {
  type: "contacts:update";
  id: string;
  patch: ContactPatch;
} & Asks<Contact>;
export const contactsCore = defineAddress<ContactsCoreMsg>("contacts.core");
/** Every contact, owner `contacts.core`. (Added: the list needs the data; R2 has no shared model.) */
export const directory = defineStream<readonly Contact[]>("contacts:directory");

// --- contacts.list: owns the selection and the selection-actions point ---------------------------
/** The selected contact (fresh from the directory), owner `contacts.list`. */
export const selection = defineStream<Contact | null>("contacts:selection");
export const selectionActions = definePoint<ActionItem>(
  "contacts:selection-actions",
  "contacts.list",
);

export type ContactsListMsg = { type: "select"; id: string };
export interface ContactsListState {
  readonly contacts: readonly { readonly id: string; readonly name: string }[];
  readonly selectedId: string | null;
}
export const listKind = defineViewKind<ContactsListState, ContactsListMsg>("contacts:list");

export interface DetailsState {
  readonly contact: Contact;
  readonly actions: readonly ActionItem[];
}
export const detailsKind = defineViewKind<DetailsState, never>("contacts:details");

// --- contacts.edit: answers contacts:edit:open ---------------------------------------------------
export type ContactEditorMsg =
  | { type: "edit"; field: "name" | "email" | "phone"; value: string }
  | { type: "save" }
  | { type: "cancel" };
export type ContactsEditMsg =
  | ({ type: "contacts:edit:open"; id: string } & Asks<void>)
  | ContactEditorMsg;
export const contactsEdit = defineAddress<ContactsEditMsg>("contacts.edit");
export interface ContactEditorState {
  readonly draft: { readonly name: string; readonly email: string; readonly phone: string };
  readonly error?: string;
  readonly save: ActionDesc;
  readonly cancel: ActionDesc;
}
export const editorKind = defineViewKind<ContactEditorState, ContactEditorMsg>("contacts:editor");
