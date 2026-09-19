import {
  type Contact,
  type ContactsCollectionView,
  contactsApiAdapter,
  contactsCollectionSlot,
  contactsUpdate,
} from "@p5/contacts/api";
import {
  answer,
  type Context,
  getConfig,
  getLogger,
  getSlots,
  isProvided,
  type Scope,
  useFields,
} from "@p5/kernel";
import { createValue } from "@p5/kit-model";
import { MemContactsApi, seedContacts } from "./mem-contacts-api.js";

export { MemContactsApi, seedContacts };

const fields = useFields({ slots: getSlots, log: getLogger, api: contactsApiAdapter.get });

/** `contacts.core`: provides `contacts:api` unless the host did; owns `contacts:collection`; answers `contacts:update`. */
export default async function contactsCore(context: Context, scope: Scope) {
  if (!isProvided(context, contactsApiAdapter.key)) {
    const delay = Number(getConfig(context)["contacts:delay-ms"] ?? 0);
    contactsApiAdapter.set(context, new MemContactsApi(seedContacts, delay));
  }
  const { slots, log, api } = fields(context);
  const contacts = createValue<readonly Contact[]>(Object.freeze([]));
  scope.defer(() => contacts.dispose());
  const publish = (rows: readonly Contact[]) =>
    contacts.set(Object.freeze(rows.map((c) => Object.freeze({ ...c }))));
  const loaded = scope
    .task(api.list())
    .then(publish, (error) => log.warn("contacts:load failed", { error: String(error) }));
  const view: ContactsCollectionView = Object.freeze({
    getContacts: contacts.get,
    onContactsUpdate: contacts.on,
  });

  scope.defer(
    answer(slots, contactsUpdate, "contacts.core", async ({ payload }) => {
      await scope.task(loaded);
      const contact = await scope.task(api.update(payload.id, payload.patch));
      publish(contacts.get().map((c) => (c.id === contact.id ? contact : c)));
      return contact;
    }),
  );
  scope.defer(slots.provide(contactsCollectionSlot, view));
}
