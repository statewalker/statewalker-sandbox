import {
  contactDetailsKind,
  contactListKind,
  contactsCollectionSlot,
  contactsEditOpen,
  contactsSelectionActionsSlot,
  contactsSelectionSlot,
} from "@p5/contacts/api";
import { type Context, getLogger, getSlots, type Scope, useFields } from "@p5/kernel";
import { attempt, drainCommits, on, type Turn } from "@p5/kit-commit";
import { getNotificationTimeout, newNotifier } from "@p5/kit-notify";
import { byOrder, followFirst } from "@p5/kit-slots";
import { menuSlot, panelsSlot } from "@p5/shell/api";
import { createContactListModel } from "./list.model.js";

const fields = useFields({ slots: getSlots, log: getLogger, timeoutMs: getNotificationTimeout });

/**
 * `contacts.list`: the list panel, the selection (owner of `contacts:selection`), the details
 * panel (published while a contact is selected), and Edit (a selection action + the main-menu item
 * "Edit contact"), which opens the editor on the contact selected AT COMMIT TIME.
 */
export default async function contactsList(context: Context, scope: Scope) {
  const { slots, log: rootLog, timeoutMs } = fields(context);
  const log = rootLog.child({ bundle: "contacts.list" });
  const notifier = newNotifier(slots, timeoutMs, log);
  scope.defer(() => notifier.dispose());
  const model = createContactListModel();
  scope.defer(() => model.dispose());

  scope.defer(
    followFirst(
      slots,
      contactsCollectionSlot,
      (c) => c.onContactsUpdate(() => model.control.publishContacts(c.getContacts())),
      () => model.control.publishContacts([]),
    ),
  );
  scope.defer(
    slots.observe(contactsSelectionActionsSlot, (items) =>
      model.control.publishSelectionActions(byOrder(items)),
    ),
  );

  // Details: a view exists exactly as long as its publication — published while selected.
  let details: (() => void) | undefined;
  scope.defer(
    model.selection.onSelectedUpdate(() => {
      const contact = model.selection.getSelected();
      if (contact && !details) {
        details = scope.defer(
          slots.register(panelsSlot, "contacts:details", {
            kind: contactDetailsKind,
            title: "Details",
            placement: "side",
            order: 20,
            model: model.selection,
          }),
        );
      } else if (!contact && details) {
        details();
        details = undefined;
      }
    }),
  );

  const edit = async (id: string, { task, call }: Turn) => {
    const result = await task(attempt(log, "open editor", () => call(contactsEditOpen, { id })));
    if (!result.ok) notifier.fail(`Could not open the editor: ${result.message}`);
  };
  drainCommits(
    { scope, slots, log },
    on(model.edit.control, edit),
    on(model.editFromMenu.control, edit),
  );

  scope.defer(
    slots.register(panelsSlot, "contacts:list", {
      kind: contactListKind,
      title: "Contacts",
      placement: "main",
      order: 20,
      model: model.view,
    }),
  );
  scope.defer(slots.provide(contactsSelectionSlot, model.selection));
  scope.defer(
    slots.provide(contactsSelectionActionsSlot, {
      id: "contacts.edit",
      order: 10,
      action: model.edit.view,
    }),
  );
  scope.defer(
    slots.provide(menuSlot, {
      id: "contacts.edit",
      group: "contacts",
      groupLabel: "Contacts",
      order: 10,
      action: model.editFromMenu.view,
    }),
  );
}
