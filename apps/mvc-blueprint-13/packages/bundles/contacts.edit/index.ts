import {
  type ContactDraft,
  type ContactsCollectionView,
  contactEditorKind,
  contactsCollectionSlot,
  contactsEditOpen,
  contactsUpdate,
} from "@p5/contacts/api";
import {
  answer,
  type Controller,
  call,
  getLogger,
  getSlots,
  type Scope,
  useFields,
} from "@p5/kernel";
import { attempt, drainCommits, on } from "@p5/kit-commit";
import { createForm } from "@p5/kit-form";
import { getNotificationTimeout, newNotifier } from "@p5/kit-notify";
import { followFirst } from "@p5/kit-slots";
import { panelsSlot } from "@p5/shell/api";
import { getValidateDelay, validateContact } from "./validate.js";

const fields = useFields({
  slots: getSlots,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
  validateMs: getValidateDelay,
});

/**
 * `contacts.edit`: answers `contacts:edit:open` with an editor SESSION — a child scope owning the
 * form model and its panel. Save is a two-step commit (validate, then `contacts:update`) on the
 * draft captured at submit; Cancel is drained after a running Save. The outcome goes to the
 * narrowest open scope: the form (errors, close) while the session is open, and in every case a
 * notification from the bundle — so a Save that finishes after Cancel or a replacing open is
 * still reported, success and failure alike. Nothing is written after deactivation.
 */
export const activate: Controller = async (context, scope) => {
  const { slots, log: rootLog, timeoutMs, validateMs } = fields(context);
  const log = rootLog.child({ bundle: "contacts.edit" });
  const notifier = newNotifier(slots, timeoutMs);
  scope.defer(() => notifier.dispose());
  let collection: ContactsCollectionView | undefined;
  scope.defer(
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

  let session: Scope | undefined; // the open editor; a new open replaces it
  scope.defer(
    answer(slots, contactsEditOpen, async ({ payload }) => {
      const contact = collection?.getContacts().find((c) => c.id === payload.id);
      if (!contact) throw new Error(`contact not found: ${payload.id}`);
      void session?.close();
      const editor = (session = scope.child());
      const { id, ...base } = contact;
      const name = contact.name;
      const model = createForm<ContactDraft, keyof ContactDraft | "form">(base);
      editor.defer(() => model.dispose());
      drainCommits(
        editor,
        log,
        on(model.control.save, async (draft, { task }) => {
          const invalid = await task(validateContact(draft, validateMs)); // step 1
          if (invalid) return model.control.reportErrors(invalid);
          const result = await task(
            attempt(
              log,
              "save contact",
              () => call(slots, contactsUpdate, { id, patch: draft }).promise,
            ), // step 2
          );
          if (!result.ok) {
            model.control.reportErrors({ form: result.message });
            notifier.notify({
              message: `Could not save ${name}: ${result.message}`,
              tone: "error",
            });
            return;
          }
          notifier.notify({ message: `Saved ${draft.name}`, tone: "success" });
          void editor.close();
        }),
        on(model.control.cancel, () => void editor.close()),
      );
      editor.defer(
        slots.register(panelsSlot, "contacts:editor", {
          kind: contactEditorKind,
          title: `Edit ${name}`,
          placement: "side",
          order: 30,
          model: model.view,
        }),
      );
    }),
  );
};
