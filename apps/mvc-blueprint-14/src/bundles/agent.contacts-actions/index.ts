import { agentActionsSlot, agentDataSlot } from "@b/agent/api";
import { type Contact, contactsEditOpen, contactsSelectionSlot } from "@b/contacts/api";
import {
  type Controller,
  getCommands,
  getSlots,
  type Listener,
  newRegistry,
  useFields,
} from "@kernel";
import { followFirst } from "@kit/slots";
import { z } from "zod";

const fields = useFields({ slots: getSlots, commands: getCommands });

/**
 * `agent.contacts-actions` (feature `agent.contacts`): the selected contact as read-only data
 * (`/data/selectedContacts`), and "open the contact editor" as an agent action (the existing
 * `contacts:edit:open`). Edits no Contacts file.
 */
export const activate: Controller = async (context) => {
  const { slots, commands } = fields(context);
  const [register, cleanup] = newRegistry();
  let read: () => Contact | undefined = () => undefined;
  const listeners = new Set<Listener>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  register(
    followFirst(
      slots,
      contactsSelectionSlot,
      (selection) => {
        read = selection.getSelected;
        return selection.onSelectedUpdate(notify);
      },
      () => {
        read = () => undefined;
        notify();
      },
    ),
  );
  register(
    slots.register(agentDataSlot, "selectedContacts", {
      description: "the contacts selected in the Contacts list: [{ id, name, email, phone }]",
      get: () => {
        const c = read();
        return c ? [{ id: c.id, name: c.name, email: c.email, phone: c.phone }] : [];
      },
      on: (listener: Listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    }),
  );
  register(
    slots.register(agentActionsSlot, "contacts.edit.open", {
      description: "Open the contact editor on one contact.",
      params: z.object({ id: z.string().min(1) }),
      run: (params: { id: string }) => commands.call(contactsEditOpen, params).promise,
    } as never),
  );
  return cleanup;
};
