import { type Controller, useFields } from "../../kernel/context.js";
import { openLog } from "../../kernel/log.js";
import { getSlots } from "../../kernel/slots.js";
import { intentAction } from "../../kit/action.js";
import { derived } from "../../kit/cell.js";
import { followSlot } from "../../kit/follow.js";
import { type Contact, selectionActionsSlot, selectionSlot } from "../contacts/api/index.js";
import { compose } from "../todos/api/index.js";

const fields = useFields({ slots: getSlots });

/**
 * Interaction (1): "New todo for this contact". Reads `contacts:selection` through the Contacts API,
 * contributes to `contacts:selection-actions`, and appends Todos' `todos:compose` intent with the
 * contact's name captured at submit. Contacts is not edited for this.
 */
export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const log = openLog(context, "todos.contacts-link");
  const selection = followSlot(
    slots,
    selectionSlot,
    (s) => ({ get: s.getSelected, subscribe: s.onSelectedUpdate }),
    undefined as Contact | undefined,
  );
  const some = derived([selection], () => selection.get() !== undefined);
  const action = intentAction(log, {
    label: "New todo for this contact",
    guard: some,
    commit: () => {
      const contact = selection.get();
      return contact ? log.append(compose, { title: contact.name }) : undefined;
    },
  });
  const off = slots.provide(selectionActionsSlot, {
    id: "todos.new-for-contact",
    order: 50,
    action: action.view,
  });
  return () => {
    off();
    action.dispose();
    some.dispose();
    selection.dispose();
    log.close();
  };
};
