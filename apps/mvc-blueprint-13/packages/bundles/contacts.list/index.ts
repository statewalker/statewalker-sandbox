import {
  contactDetailsKind,
  contactListKind,
  contactsCollectionSlot,
  contactsEditOpen,
  contactsSelectionActionsSlot,
  contactsSelectionSlot,
} from "@p5/contacts/api";
import { menuSlot, panelsSlot } from "@p5/shell/api";
import { type Controller, call, getLogger, getSlots, newRegistry, useFields } from "@p5/kernel";
import { attempt, newUpdateLoop } from "@p5/kit-loop";
import { onSubmits } from "@p5/kit-model";
import { byOrder, followFirst } from "@p5/kit-slots";
import { createContactListModel } from "./list.model.js";

const fields = useFields({ slots: getSlots, log: getLogger });

/**
 * `contacts.list`: the list panel, the selection (owner of `contacts:selection`), the details
 * panel (published while a contact is selected), and Edit (a selection action + the main-menu item
 * "Edit contact"), which opens the editor on the contact selected AT COMMIT TIME.
 */
export const activate: Controller = async (context) => {
  const { slots, log: rootLog } = fields(context);
  const log = rootLog.child({ bundle: "contacts.list" });
  const [register, cleanup] = newRegistry();
  let active = true;
  const model = createContactListModel();
  register(() => model.dispose());

  register(
    followFirst(
      slots,
      contactsCollectionSlot,
      (c) => c.onContactsUpdate(() => model.control.publishContacts(c.getContacts())),
      () => model.control.publishContacts([]),
    ),
  );
  register(
    slots.observe(contactsSelectionActionsSlot, (items) =>
      model.control.publishSelectionActions(byOrder(items)),
    ),
  );

  // Details: a view exists exactly as long as its publication — published while selected.
  let withdrawDetails: (() => void) | undefined;
  register(
    model.selection.onSelectedUpdate(() => {
      const contact = model.selection.getSelected();
      if (contact && !withdrawDetails) {
        withdrawDetails = slots.register(panelsSlot, "contacts:details", {
          kind: contactDetailsKind,
          title: "Details",
          placement: "side",
          order: 20,
          model: model.selection,
        });
      } else if (!contact && withdrawDetails) {
        withdrawDetails();
        withdrawDetails = undefined;
      }
    }),
  );
  register(() => withdrawDetails?.());

  let editOwed: string | undefined;
  const loop = newUpdateLoop(
    async () => {
      const id = editOwed;
      editOwed = undefined;
      if (id === undefined) return;
      await attempt(
        log,
        "open the contact editor",
        () => call(slots, contactsEditOpen, { id }).promise,
      );
    },
    {
      isActive: () => active,
      onError: (error) => log.error("contacts.list: pass failed", { error: String(error) }),
    },
  );
  for (const action of [model.edit, model.editFromMenu]) {
    register(
      onSubmits(action.control, () => {
        editOwed = model.selection.getSelected()?.id;
        loop.kick();
      }),
    );
  }

  register(
    slots.register(panelsSlot, "contacts:list", {
      kind: contactListKind,
      title: "Contacts",
      placement: "main",
      order: 20,
      model: model.view,
    }),
  );
  register(slots.provide(contactsSelectionSlot, model.selection));
  register(
    slots.provide(contactsSelectionActionsSlot, {
      id: "contacts.edit",
      order: 10,
      action: model.edit.view,
    }),
  );
  register(
    slots.provide(menuSlot, {
      id: "contacts.edit",
      group: "contacts",
      groupLabel: "Contacts",
      order: 10,
      action: model.editFromMenu.view,
    }),
  );
  return async () => {
    active = false;
    await cleanup();
  };
};
