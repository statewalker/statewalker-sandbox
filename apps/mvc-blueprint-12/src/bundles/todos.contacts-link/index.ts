import { contactsSelectionActionsSlot, contactsSelectionSlot } from "@b/contacts/api";
import { todosCompose } from "@b/todos/api";
import { type Controller, getCommands, getLogger, getSlots, newRegistry, useFields } from "@kernel";
import { createAction, onSubmits } from "@kit/model";
import { firstOf } from "@kit/slots";

const fields = useFields({ slots: getSlots, commands: getCommands, log: getLogger });

/**
 * `todos.contacts-link` (feature `todos-contacts`): "New todo for this contact" in
 * `contacts:selection-actions`. P4: `enabled` is DERIVED in the action model from
 * `contacts:selection` on the shared substrate (no listener sets it). On submit it reads the
 * selected contact AT COMMIT TIME and calls `todos:compose`. Edits no Contacts file.
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log } = fields(context);
  const [register, cleanup] = newRegistry();
  let active = true;
  const [selection, stop] = firstOf(slots, contactsSelectionSlot);
  register(stop);
  const selected = () => selection()?.selected();
  const action = createAction({
    label: "New todo for this contact",
    when: () => selected() !== undefined,
  });
  register(() => action.dispose());
  register(
    onSubmits(action.control, () => {
      const contact = selected(); // at commit time (the listener runs untracked)
      if (!contact || !active) return;
      const title = contact.name;
      queueMicrotask(() => {
        if (!active) return;
        commands
          .call(todosCompose, { title })
          .promise.catch((error) => log.warn("todos:compose failed", { error: String(error) }));
      });
    }),
  );
  register(
    slots.provide(contactsSelectionActionsSlot, {
      id: "todos.new-for-contact",
      order: 50,
      action: action.view,
    }),
  );
  return async () => {
    active = false;
    await cleanup();
  };
};
