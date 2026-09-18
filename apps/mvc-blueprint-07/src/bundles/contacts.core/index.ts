import { type Controller, useFields } from "../../kernel/context.js";
import { defineIntent, isOutcome, openLog } from "../../kernel/log.js";
import { getSlots } from "../../kernel/slots.js";
import { cell } from "../../kit/cell.js";
import {
  type Contact,
  type ContactsDirectoryView,
  directorySlot,
  getContactApi,
  hasContactApi,
  setContactApi,
  updateContact,
} from "../contacts/api/index.js";
import { createMemContactApi } from "./mem-api.js";

const load = defineIntent<void, Contact[]>("contacts.core:load");
const fields = useFields({ slots: getSlots });

export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  if (!hasContactApi(context)) setContactApi(context, createMemContactApi());
  const api = getContactApi(context);
  const log = openLog(context, "contacts.core");
  log.handle(load, () => api.list());
  log.handle(updateContact, ({ payload }) => api.update(payload.id, payload.patch));

  const contacts = cell<readonly Contact[]>([]);
  log.project((record) => {
    if (isOutcome(record, load) && record.ok) contacts.set(record.value ?? []);
    if (isOutcome(record, updateContact) && record.ok && record.value) {
      const next = record.value;
      contacts.set(contacts.get().map((c) => (c.id === next.id ? next : c)));
    }
  });
  const view: ContactsDirectoryView = Object.freeze({
    getContacts: contacts.get,
    onContactsUpdate: contacts.subscribe,
  });
  const unpublish = slots.provide(directorySlot, view);
  log.append(load, undefined);
  return () => {
    unpublish();
    log.close();
    contacts.dispose();
  };
};
