import {
  type ContactsCollectionView,
  contactEditorKind,
  contactsCollectionSlot,
  contactsEditOpen,
  contactsUpdate,
} from "@b/contacts/api";
import { panelsSlot } from "@b/shell/api";
import { type Controller, getCommands, getLogger, getSlots, newRegistry, useFields } from "@kernel";
import { drainCommits, on } from "@kit/commit";
import { attempt } from "@kit/loop";
import { getNotificationTimeout, newNotifier } from "@kit/notify";
import { followFirst } from "@kit/slots";
import { getValidateDelay, validateContact } from "../validate.js";
import { createContactEditorModel } from "./editor.model.js";

const fields = useFields({
  slots: getSlots,
  commands: getCommands,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
  validateMs: getValidateDelay,
});

/**
 * `contacts.edit`, mechanism C: Save's records carry the draft captured at submit; the session's
 * drain handles Save and Cancel one at a time in commit order. `running` (and the refusal of a
 * second Save) is the action's own: a record is unsettled.
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog, timeoutMs, validateMs } = fields(context);
  const log = rootLog.child({ bundle: "contacts.edit" });
  const [register, cleanup] = newRegistry();
  const notifier = newNotifier(slots, timeoutMs);
  register(() => notifier.dispose());
  let active = true;
  let closeSession: (() => void) | undefined;
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
  const onError = (error: unknown) =>
    log.error("contacts.edit: commit failed", { error: String(error) });

  register(
    commands.listen(contactsEditOpen, async ({ payload }) => {
      const contact = collection?.getContacts().find((c) => c.id === payload.id);
      if (!contact) throw new Error(`contact not found: ${payload.id}`);
      if (!active) return;
      closeSession?.();
      const { id, ...base } = contact;
      const model = createContactEditorModel(base);
      const [own, release] = newRegistry();
      const close = () => {
        if (closeSession === close) closeSession = undefined;
        void release();
      };
      own(() => model.dispose());
      own(
        drainCommits(
          { isActive: () => active, onError },
          on(model.control.save, async (draft) => {
            const invalid = await validateContact(draft, validateMs); // step 1
            if (!active) return;
            if (invalid) return model.control.reportErrors(invalid);
            const result = await attempt(
              log,
              "save contact",
              () => commands.call(contactsUpdate, { id, patch: draft }).promise, // step 2
            );
            if (!active) return;
            if (!result.ok) {
              model.control.reportErrors({ form: result.message });
              return notifier.notify({ message: `Save failed: ${result.message}`, tone: "error" });
            }
            notifier.notify({ message: "Saved", tone: "success" });
            close();
          }),
          on(model.control.cancel, close),
        ),
      );
      own(
        slots.register(panelsSlot, "contacts:editor", {
          kind: contactEditorKind,
          title: `Edit ${contact.name}`,
          placement: "side",
          order: 30,
          model: model.view,
        }),
      );
      closeSession = close;
    }),
  );
  register(() => closeSession?.());
  return async () => {
    active = false;
    await cleanup();
  };
};
