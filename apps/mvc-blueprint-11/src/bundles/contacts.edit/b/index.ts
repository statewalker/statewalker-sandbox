import {
  type ContactsCollectionView,
  contactEditorKind,
  contactsCollectionSlot,
  contactsEditOpen,
  contactsUpdate,
} from "@b/contacts/api";
import { panelsSlot } from "@b/shell/api";
import { type Controller, getCommands, getLogger, getSlots, newRegistry, useFields } from "@kernel";
import { attempt, newUpdateLoop } from "@kit/loop";
import { onSubmits } from "@kit/model";
import { getNotificationTimeout, newNotifier } from "@kit/notify";
import { followFirst } from "@kit/slots";
import { getValidateDelay, validateContact } from "../validate.js";
import { type ContactEditorModel, createContactEditorModel } from "./editor.model.js";

const fields = useFields({
  slots: getSlots,
  commands: getCommands,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
  validateMs: getValidateDelay,
});

interface Session {
  readonly id: string;
  readonly model: ContactEditorModel;
  readonly withdraw: () => void;
  /** The last commit seq this controller took. */
  handled: number;
  cancelled: boolean;
}

/**
 * `contacts.edit`, mechanism B: the form hands over its commit (the draft frozen at submit); the
 * controller takes the newest unhandled commit in its pass and settles it. `running` and the
 * refusal of a second Save are the form's. Otherwise as mechanism A:
 * answers `contacts:edit:open` with the editor seeded from the stored contact.
 * Save commits the form AT COMMIT TIME, closes on success and notifies "Saved"; a failure keeps
 * the editor with the error on the form and an error notification. Save is REFUSED while running.
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog, timeoutMs, validateMs } = fields(context);
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
    const commit = s.model.control.getCommit();
    if (!commit || commit.seq <= s.handled) return;
    s.handled = commit.seq;
    try {
      // Step 1: validate (async). Step 2: update. Both on the draft the form committed.
      const invalid = await validateContact(commit.draft, validateMs);
      if (!active || session !== s) return;
      if (invalid) return s.model.control.reportErrors(invalid);
      const result = await attempt(
        log,
        "save contact",
        () => commands.call(contactsUpdate, { id: s.id, patch: commit.draft }).promise,
      );
      if (!active) return;
      if (result.ok) notifier.notify({ message: "Saved", tone: "success" });
      if (session !== s) return;
      if (result.ok) return close(s);
      s.model.control.reportErrors({ form: result.message });
      notifier.notify({ message: `Save failed: ${result.message}`, tone: "error" });
    } finally {
      s.model.control.settle(commit.seq);
    }
  }

  register(
    commands.listen(contactsEditOpen, async ({ payload }) => {
      const contact = collection?.getContacts().find((c) => c.id === payload.id);
      if (!contact) throw new Error(`contact not found: ${payload.id}`);
      if (!active) return;
      close(session);
      const { id, ...base } = contact;
      const model = createContactEditorModel(base);
      const [own, release] = newRegistry();
      own(() => model.dispose());
      const s: Session = {
        id,
        model,
        withdraw: () => void release(),
        handled: 0,
        cancelled: false,
      };
      own(model.control.onCommitUpdate(() => loop.kick()));
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
