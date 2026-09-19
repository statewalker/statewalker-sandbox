import { contactsSelectionActionsSlot, contactsSelectionSlot } from "@p5/contacts/api";
import { type Controller, call, getLogger, getSlots, useFields } from "@p5/kernel";
import { attempt, createCommitAction, drainCommits, on } from "@p5/kit-commit";
import { trackFirst } from "@p5/kit-track";
import { todosCompose } from "@p5/todos/api";

const fields = useFields({ slots: getSlots, log: getLogger });

/**
 * `todos.contacts-link` (feature `todos-contacts`): "New todo for this contact" in
 * `contacts:selection-actions`. Enabled while `contacts:selection` has a contact (a kit guard
 * over the other bundle's selection); the record carries the contact's name AT SUBMIT and the
 * handler calls `todos:compose`. Edits no Contacts file.
 */
export const activate: Controller = async (context, scope) => {
  const { slots, log } = fields(context);
  const [selected, stop] = trackFirst(slots, contactsSelectionSlot, (s) => [
    s.getSelected,
    s.onSelectedUpdate,
  ]);
  scope.defer(stop);
  const action = createCommitAction({
    label: "New todo for this contact",
    when: () => selected() !== undefined,
    capture: () => selected()?.name ?? "",
  });
  scope.defer(() => action.dispose());
  drainCommits(
    scope,
    log,
    on(action.control, (title, { task }) =>
      task(attempt(log, "todos:compose", () => call(slots, todosCompose, { title }).promise)),
    ),
  );
  scope.defer(
    slots.provide(contactsSelectionActionsSlot, {
      id: "todos.new-for-contact",
      order: 50,
      action: action.view,
    }),
  );
};
