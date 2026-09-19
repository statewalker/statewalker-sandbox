import { contactsSelectionActionsSlot, contactsSelectionSlot } from "@p5/contacts/api";
import { todosCompose } from "@p5/todos/api";
import { type Controller, call, getLogger, getSlots, newRegistry, useFields } from "@p5/kernel";
import { createAction, onSubmits } from "@p5/kit-model";
import { followFirst } from "@p5/kit-slots";

const fields = useFields({ slots: getSlots, log: getLogger });

/**
 * `todos.contacts-link` (feature `todos-contacts`): "New todo for this contact" in
 * `contacts:selection-actions`. Enabled while `contacts:selection` has a contact; on submit it
 * reads the selected contact AT COMMIT TIME and calls `todos:compose`. Edits no Contacts file.
 */
export const activate: Controller = async (context) => {
  const { slots, log } = fields(context);
  const [register, cleanup] = newRegistry();
  let active = true;
  const action = createAction({ label: "New todo for this contact", enabled: false });
  register(() => action.dispose());
  let selected: (() => { name: string } | undefined) | undefined;
  register(
    followFirst(
      slots,
      contactsSelectionSlot,
      (selection) => {
        selected = selection.getSelected;
        return selection.onSelectedUpdate(() =>
          action.control.update({ enabled: selection.getSelected() !== undefined }),
        );
      },
      () => {
        selected = undefined;
        action.control.update({ enabled: false });
      },
    ),
  );
  register(
    onSubmits(action.control, () => {
      const contact = selected?.(); // at commit time
      if (!contact || !active) return;
      const title = contact.name;
      queueMicrotask(() => {
        if (!active) return;
        call(slots, todosCompose, { title }).promise.catch((error) =>
          log.warn("todos:compose failed", { error: String(error) }),
        );
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
