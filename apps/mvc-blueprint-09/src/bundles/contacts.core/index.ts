import {
  type Contact,
  type ContactsCollectionView,
  contactsApiAdapter,
  contactsCollectionSlot,
  contactsUpdate,
} from "@b/contacts/api";
import {
  type Controller,
  answer,
  getConfig,
  getLogger,
  getSlots,
  isProvided,
  newRegistry,
  useFields,
} from "@kernel";
import { createValue } from "@kit/model";
import { MemContactsApi, seedContacts } from "./mem-contacts-api.js";

export { MemContactsApi, seedContacts };

const fields = useFields({
  slots: getSlots,
  log: getLogger,
  api: contactsApiAdapter.get,
});

/** `contacts.core`: provides `contacts:api` unless the host did; owns `contacts:collection`; answers `contacts:update`. */
export const activate: Controller = async (context) => {
  if (!isProvided(context, contactsApiAdapter.key)) {
    const delay = Number(getConfig(context)["contacts:delay-ms"] ?? 0);
    contactsApiAdapter.set(context, new MemContactsApi(seedContacts, delay));
  }
  const { slots, log: rootLog, api } = fields(context);
  const log = rootLog.child({ bundle: "contacts.core" });
  const [register, cleanup] = newRegistry();
  let active = true;

  const contacts = createValue<readonly Contact[]>(Object.freeze([]));
  register(() => contacts.dispose());
  const publish = (rows: readonly Contact[]) =>
    contacts.set(Object.freeze(rows.map((c) => Object.freeze({ ...c }))));
  const loaded = api.list().then(
    (rows) => {
      if (active) publish(rows);
    },
    (error) => log.warn("contacts:load failed", { error: String(error) }),
  );
  const view: ContactsCollectionView = Object.freeze({
    getContacts: contacts.get,
    onContactsUpdate: contacts.on,
  });

  register(
    answer(slots, contactsUpdate, async ({ payload }) => {
      await loaded;
      const contact = await api.update(payload.id, payload.patch);
      if (active) publish(contacts.get().map((c) => (c.id === contact.id ? contact : c)));
      return contact;
    }),
  );
  register(slots.provide(contactsCollectionSlot, view));

  return async () => {
    active = false;
    await cleanup();
  };
};
