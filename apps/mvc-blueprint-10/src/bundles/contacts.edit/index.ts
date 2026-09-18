import {
  type Contact,
  type ContactDraft,
  type ContactsCollectionView,
  contactEditorKind,
  contactsCollectionSlot,
  contactsEditOpen,
  contactsUpdate,
} from "@b/contacts/api";
import { panelsSlot } from "@b/shell/api";
import { type Controller, getCommands, getLogger, getSlots, newRegistry, useFields } from "@kernel";
import { startMachine } from "@kit/machine";
import { onSubmits } from "@kit/model";
import { getNotificationTimeout, newNotifier } from "@kit/notify";
import { followFirst } from "@kit/slots";
import { createContactEditorModel } from "./editor.model.js";
import { contactEditorChart } from "./machine.js";

const fields = useFields({
  slots: getSlots,
  commands: getCommands,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
});

/**
 * `contacts.edit`: answers `contacts:edit:open` with the editor seeded from the stored contact.
 * Save commits the form AT COMMIT TIME, closes on success and notifies "Saved"; a failure keeps
 * the editor with the error on the form and an error notification. The lifecycle is the chart in
 * `machine.ts`.
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog, timeoutMs } = fields(context);
  const log = rootLog.child({ bundle: "contacts.edit" });
  const [register, cleanup] = newRegistry();
  const notifier = newNotifier(slots, timeoutMs);
  register(() => notifier.dispose());
  let collection: ContactsCollectionView | undefined;
  register(
    followFirst(
      slots,
      contactsCollectionSlot,
      (c) => {
        collection = c;
        return () => {};
      },
      () => {
        collection = undefined;
      },
    ),
  );

  const machine = startMachine(
    contactEditorChart,
    {
      open: (scope) => {
        const { id, ...base } = scope.data as Contact;
        const model = createContactEditorModel(base);
        const [own, release] = newRegistry();
        own(() => model.dispose());
        own(onSubmits(model.control.save, () => scope.send("save", model.view.getDraft())));
        own(onSubmits(model.control.cancel, () => scope.send("cancel")));
        own(
          slots.register(panelsSlot, "contacts:editor", {
            kind: contactEditorKind,
            title: `Edit ${base.name}`,
            placement: "side",
            order: 30,
            model: model.view,
          }),
        );
        return {
          exit: () => void release(),
          states: {
            saving: ({ data, task }) => {
              model.control.save.update({ running: true });
              task(
                () => commands.call(contactsUpdate, { id, patch: data as ContactDraft }).promise,
                (result) => {
                  if (result.ok) {
                    notifier.notify({ message: "Saved", tone: "success" });
                    return "saved";
                  }
                  model.control.reportErrors({ form: result.message });
                  notifier.notify({ message: `Save failed: ${result.message}`, tone: "error" });
                  return "failed";
                },
              );
            },
            // `running` follows the state; not reset on exit, so a stop leaves the model as it was.
            editing: () => model.control.save.update({ running: false }),
          },
        };
      },
    },
    { log, name: "contacts.edit" },
  );
  register(() => machine.stop());

  register(
    commands.listen(contactsEditOpen, async ({ payload }) => {
      const contact = collection?.getContacts().find((c) => c.id === payload.id);
      if (!contact) throw new Error(`contact not found: ${payload.id}`);
      machine.send("open", contact);
    }),
  );
  return cleanup;
};
