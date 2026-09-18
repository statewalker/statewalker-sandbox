import { type Controller, useFields } from "../../kernel/context.js";
import { defineEvent, isIntent, openLog } from "../../kernel/log.js";
import { getSlots } from "../../kernel/slots.js";
import { cell, derived } from "../../kit/cell.js";
import { followList, followSlot } from "../../kit/follow.js";
import {
  type Contact,
  type ContactDetailsView,
  type ContactSelectionView,
  type ContactsListView,
  contactDetailsKind,
  contactsListKind,
  directorySlot,
  selectionActionsSlot,
  selectionSlot,
} from "../contacts/api/index.js";
import { panelsSlot } from "../shell/api/index.js";

const selected = defineEvent<{ id: string }>("contacts.list:select");
const fields = useFields({ slots: getSlots });

export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const log = openLog(context, "contacts.list");
  const contacts = followSlot(
    slots,
    directorySlot,
    (d) => ({ get: d.getContacts, subscribe: d.onContactsUpdate }),
    [] as readonly Contact[],
  );
  const pickedId = cell<string | undefined>(undefined);
  const offFold = log.project((record) => {
    if (isIntent(record, selected)) pickedId.set(record.payload.id);
  });
  const current = derived([pickedId, contacts], () =>
    contacts.get().find((c) => c.id === pickedId.get()),
  );
  const selectionView: ContactSelectionView = Object.freeze({
    getSelected: current.get,
    onSelectedUpdate: current.subscribe,
  });
  const items = derived([contacts, pickedId], () =>
    contacts.get().map((c) => ({ id: c.id, name: c.name, selected: c.id === pickedId.get() })),
  );
  const actions = followList(slots, selectionActionsSlot);
  const model: ContactsListView = Object.freeze({
    getItems: items.get,
    onItemsUpdate: items.subscribe,
    getActions: actions.get,
    onActionsUpdate: actions.subscribe,
    select: (id: string) => void (!log.closed && log.append(selected, { id })),
  });
  const details: ContactDetailsView = Object.freeze({
    getContact: current.get,
    onContactUpdate: current.subscribe,
  });

  const offs = [
    slots.provide(selectionSlot, selectionView),
    slots.register(panelsSlot, "contacts:list", {
      kind: contactsListKind,
      title: "Contacts",
      placement: "main",
      order: 10,
      model,
    }),
  ];
  // The details panel exists exactly while a contact is selected.
  let withdrawDetails: (() => void) | undefined;
  const offDetails = current.subscribe(() => {
    const has = current.get() !== undefined;
    if (has && !withdrawDetails) {
      withdrawDetails = slots.register(panelsSlot, "contacts:details", {
        kind: contactDetailsKind,
        title: "Contact",
        placement: "side",
        model: details,
      });
    } else if (!has && withdrawDetails) {
      withdrawDetails();
      withdrawDetails = undefined;
    }
  });

  return () => {
    offDetails();
    withdrawDetails?.();
    for (const off of offs.reverse()) off();
    offFold();
    log.close();
    for (const x of [actions, items, current, pickedId, contacts]) x.dispose();
  };
};
