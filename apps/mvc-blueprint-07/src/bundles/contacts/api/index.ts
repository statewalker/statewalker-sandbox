/** The Contacts API (§14.3). Declarations only. */
import { defineService } from "../../../kernel/context.js";
import { defineIntent } from "../../../kernel/log.js";
import { type ActionEntry, type ActionView, defineViewKind } from "../../../kernel/models.js";
import { defineSlot } from "../../../kernel/slots.js";

export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
}
export type ContactPatch = Partial<Omit<Contact, "id">>;
export interface ContactApi {
  list(): Promise<Contact[]>;
  get(id: string): Promise<Contact>;
  /** rejects when `name` is empty after trimming */
  update(id: string, patch: ContactPatch): Promise<Contact>;
}
export const [getContactApi, setContactApi, hasContactApi] =
  defineService<ContactApi>("contacts:api");

export interface ContactsDirectoryView {
  getContacts(): readonly Contact[];
  onContactsUpdate(listener: () => void): () => void;
}
/** Owner: `contacts.core` — a projection of the outcomes of contacts intents. */
export const directorySlot = defineSlot<ContactsDirectoryView>("contacts:directory");

export interface ContactSelectionView {
  getSelected(): Contact | undefined;
  onSelectedUpdate(listener: () => void): () => void;
}
/** Owner: `contacts.list`. */
export const selectionSlot = defineSlot<ContactSelectionView>("contacts:selection");
export const selectionActionsSlot = defineSlot<ActionEntry>("contacts:selection-actions");

/** answered by contacts.core: the stored contact */
export const updateContact = defineIntent<{ id: string; patch: ContactPatch }, Contact>(
  "contacts:update",
);
/** answered by contacts.edit once the editor is published */
export const openContactEditor = defineIntent<{ id: string }>("contacts:edit:open");

export interface ContactsListView {
  getItems(): readonly { id: string; name: string; selected: boolean }[];
  onItemsUpdate(listener: () => void): () => void;
  getActions(): readonly ActionEntry[];
  onActionsUpdate(listener: () => void): () => void;
  select(id: string): void;
}
export const contactsListKind = defineViewKind<ContactsListView>("contacts:list");

export interface ContactDetailsView {
  getContact(): Contact | undefined;
  onContactUpdate(listener: () => void): () => void;
}
export const contactDetailsKind = defineViewKind<ContactDetailsView>("contacts:details");

export type ContactDraft = Omit<Contact, "id">;
export interface ContactEditorView {
  getDraft(): ContactDraft;
  onDraftUpdate(listener: () => void): () => void;
  getStatus(): { readonly error?: string };
  onStatusUpdate(listener: () => void): () => void;
  editField<K extends keyof ContactDraft>(field: K, value: ContactDraft[K]): void;
  readonly save: ActionView;
  readonly cancel: ActionView;
}
export const contactEditorKind = defineViewKind<ContactEditorView>("contacts:editor");
