import {
  type ContactDraft,
  contactEditorKind,
  contactsCollectionSlot,
  contactsEditOpen,
  contactsUpdate,
} from "@p5/contacts/api";
import { answer, type Context, getLogger, getSlots, type Scope, useFields } from "@p5/kernel";
import { attempt, drainCommits, on } from "@p5/kit-commit";
import { changes, createForm } from "@p5/kit-form";
import { getNotificationTimeout, newNotifier } from "@p5/kit-notify";
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
 * form model and its panel. Save is a two-step commit (validate, then `contacts:update` with the
 * CHANGED fields only) on the draft captured at submit; Cancel is its own lane and closes at once.
 * Outcome rule: every failure notifies, and writes the form too while the session is open; a Save
 * that finishes after Cancel or a replacing open is still reported. Nothing after deactivation.
 */
export default async function contactsEdit(context: Context, scope: Scope) {
  const { slots, log: rootLog, timeoutMs, validateMs } = fields(context);
  const log = rootLog.child({ bundle: "contacts.edit" });
  const notifier = newNotifier(slots, timeoutMs, log);
  scope.defer(() => notifier.dispose());

  let session: Scope | undefined; // the open editor; a new open replaces it
  scope.defer(
    answer(slots, contactsEditOpen, "contacts.edit", ({ payload }) => {
      const collection = slots.getSnapshot(contactsCollectionSlot)[0]; // a one-shot read
      const contact = collection?.getContacts().find((c) => c.id === payload.id);
      if (!contact) throw new Error(`contact not found: ${payload.id}`);
      void session?.close(); // withdraws synchronously, before the panel id is registered again
      const editor = (session = scope.child());
      const { id, ...base } = contact;
      const name = contact.name;
      const model = createForm<ContactDraft, keyof ContactDraft | "form">(base);
      editor.defer(() => model.dispose());
      const drain = { scope, session: editor, slots, log };
      drainCommits(
        drain,
        on(model.control.save, async (draft, { task, call }) => {
          const fail = (errors: { form: string; email?: string }) => {
            model.control.reportErrors(errors); // ignored once the session closed
            notifier.fail(`Could not save ${name}: ${errors.form}`);
          };
          const invalid = await task(validateContact(draft, validateMs)); // step 1
          if (invalid) return fail(invalid);
          const patch = changes(base, draft); // only what this editor changed (no lost update)
          const result = await task(
            attempt(log, "save contact", () => call(contactsUpdate, { id, patch })), // step 2
          );
          if (!result.ok) return fail({ form: result.message });
          notifier.notify({ message: `Saved ${draft.name}`, tone: "success" });
          void editor.close();
        }),
      );
      drainCommits(
        drain,
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
}
