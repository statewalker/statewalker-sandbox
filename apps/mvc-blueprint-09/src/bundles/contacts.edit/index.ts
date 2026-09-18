import {
  type ContactDraft,
  type ContactsCollectionView,
  contactEditorKind,
  contactsCollectionSlot,
  contactsEditOpen,
  contactsUpdate,
} from "@b/contacts/api";
import { panelsSlot } from "@b/shell/api";
import {
  answer,
  type Controller,
  call,
  getLogger,
  getSlots,
  newRegistry,
  useFields,
} from "@kernel";
import { attempt, newUpdateLoop } from "@kit/loop";
import { onSubmits } from "@kit/model";
import { getNotificationTimeout, newNotifier } from "@kit/notify";
import { followFirst } from "@kit/slots";
import { type ContactEditorModel, createContactEditorModel } from "./editor.model.js";

const fields = useFields({
  slots: getSlots,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
});

interface Session {
  readonly id: string;
  readonly model: ContactEditorModel;
  readonly withdraw: () => void;
  commit?: ContactDraft;
  cancelled: boolean;
}

/**
 * `contacts.edit`: answers `contacts:edit:open` with the editor seeded from the stored contact.
 * Save commits the form AT COMMIT TIME, closes on success and notifies "Saved"; a failure keeps
 * the editor with the error on the form and an error notification. Save is REFUSED while running.
 */
export const activate: Controller = async (context) => {
  const { slots, log: rootLog, timeoutMs } = fields(context);
  const log = rootLog.child({ bundle: "contacts.edit" });
  const [register, cleanup] = newRegistry();
  const notifier = newNotifier(slots, timeoutMs);
  register(() => notifier.dispose());
  let active = true;
  let session: Session | undefined;
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
  const loop = newUpdateLoop(pass, {
    isActive: () => active,
    onError: (error) => log.error("contacts.edit: pass failed", { error: String(error) }),
  });

  function close(s: Session | undefined): void {
    if (!s) return;
    if (session === s) session = undefined;
    s.withdraw();
  }

  async function pass(): Promise<void> {
    const s = session;
    if (!s) return;
    if (s.cancelled) return close(s);
    const commit = s.commit;
    if (!commit) return;
    s.commit = undefined;
    const { save } = s.model.control;
    save.update({ running: true });
    const result = await attempt(
      log,
      "save contact",
      () => call(slots, contactsUpdate, { id: s.id, patch: commit }).promise,
    );
    if (!active) return;
    if (result.ok) notifier.notify({ message: "Saved", tone: "success" });
    if (session !== s) return;
    save.update({ running: false });
    if (result.ok) return close(s);
    s.model.control.reportErrors({ form: result.message });
    notifier.notify({ message: `Save failed: ${result.message}`, tone: "error" });
  }

  register(
    answer(slots, contactsEditOpen, async ({ payload }) => {
      const contact = collection?.getContacts().find((c) => c.id === payload.id);
      if (!contact) throw new Error(`contact not found: ${payload.id}`);
      if (!active) return;
      close(session);
      const { id, ...base } = contact;
      const model = createContactEditorModel(base);
      const [own, release] = newRegistry();
      own(() => model.dispose());
      const s: Session = { id, model, withdraw: () => void release(), cancelled: false };
      own(
        onSubmits(model.control.save, () => {
          s.commit ??= model.view.getDraft();
          loop.kick();
        }),
      );
      own(
        onSubmits(model.control.cancel, () => {
          s.cancelled = true;
          loop.kick();
        }),
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
      session = s;
    }),
  );
  register(() => close(session));
  return async () => {
    active = false;
    await cleanup();
  };
};
