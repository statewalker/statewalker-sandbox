import {
  type ActionContribution,
  type ActionView,
  defineCommand,
  defineSlot,
  defineViewKind,
  type Listener,
  newAdapter,
  type Unsubscribe,
} from "@p5/kernel";

/**
 * The Contacts API. Declarations only.
 */

// ── data and the injected api ───────────────────────────────────────────────────────────────
export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
}
export type ContactPatch = Partial<Omit<Contact, "id">>;
export interface ContactsApi {
  list(): Promise<Contact[]>;
  get(id: string): Promise<Contact | undefined>;
  /** Rejects when `name` is empty after trimming. */
  update(id: string, patch: ContactPatch): Promise<Contact>;
}
/** `contacts:api` — provided by `contacts.core` unless the host already set one. */
export const contactsApiAdapter = newAdapter<ContactsApi>("contacts:api");

// ── shared state ─────────────────────────────────────────────────────────────────────────────
/** Presentation, owner `contacts.core`. */
export interface ContactsCollectionView {
  getContacts(): readonly Contact[];
  onContactsUpdate(listener: Listener): Unsubscribe;
}
export const contactsCollectionSlot = defineSlot<ContactsCollectionView>("contacts:collection");

/** Presentation, owner `contacts.list`. */
export interface ContactSelectionView {
  getSelected(): Contact | undefined;
  onSelectedUpdate(listener: Listener): Unsubscribe;
}
/** One contribution: the selected contact, published by `contacts.list`. */
export const contactsSelectionSlot = defineSlot<ContactSelectionView>("contacts:selection");

// ── extension points ─────────────────────────────────────────────────────────────────────────
/** Edit, and anything another app contributes. Acts on `contacts:selection`. */
export const contactsSelectionActionsSlot = defineSlot<ActionContribution>(
  "contacts:selection-actions",
);

// ── commands (answered by Contacts) ──────────────────────────────────────────────────────────
/** Publishes the editor seeded from the stored contact. (`contacts.edit`) */
export const contactsEditOpen = defineCommand<{ id: string }, void>("contacts:edit:open");
/** The write, answered by the collection's owner `contacts.core`. */
export const contactsUpdate = defineCommand<{ id: string; patch: ContactPatch }, Contact>(
  "contacts:update",
);

// ── view models and kinds ────────────────────────────────────────────────────────────────────
export interface ContactListView {
  getContacts(): readonly Contact[];
  onContactsUpdate(listener: Listener): Unsubscribe;
  /** Input: the selected id (dropped on read when the contact is gone). */
  getSelectedId(): string | undefined;
  onSelectedIdUpdate(listener: Listener): Unsubscribe;
  select(id: string | undefined): void;
  getSelectionActions(): readonly ActionContribution[];
  onSelectionActionsUpdate(listener: Listener): Unsubscribe;
}

export interface ContactDetailsView {
  getContact(): Contact | undefined;
  onContactUpdate(listener: Listener): Unsubscribe;
}

export type ContactDraft = Omit<Contact, "id">;
export interface ContactFormStatus {
  readonly touched: boolean;
  readonly dirty: boolean;
  readonly errors: Readonly<Partial<Record<keyof ContactDraft | "form", string>>>;
}
export interface ContactEditorView {
  getDraft(): ContactDraft;
  onDraftUpdate(listener: Listener): Unsubscribe;
  getStatus(): ContactFormStatus;
  onStatusUpdate(listener: Listener): Unsubscribe;
  editField<K extends keyof ContactDraft>(field: K, value: ContactDraft[K]): void;
  readonly save: ActionView;
  readonly cancel: ActionView;
}

export const contactListKind = defineViewKind<ContactListView>("contacts:list");
export const contactDetailsKind = defineViewKind<ContactDetailsView>("contacts:details");
export const contactEditorKind = defineViewKind<ContactEditorView>("contacts:editor");
