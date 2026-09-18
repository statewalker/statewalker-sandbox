import {
  type Contact,
  type ContactsCollectionView,
  contactEditorKind,
  contactsCollectionSlot,
  contactsEditOpen,
  contactsUpdate,
} from "@b/contacts/api";
import { panelsSlot } from "@b/shell/api";
import { type Controller, getCommands, getLogger, getSlots, newRegistry, useFields } from "@kernel";
import { describeError } from "@kit/loop";
import { onSubmits } from "@kit/model";
import { getNotificationTimeout, newNotifier } from "@kit/notify";
import { followFirst } from "@kit/slots";
import { createActor, fromCallback, fromPromise } from "xstate";
import { createContactEditorModel } from "./editor.model.js";
import { contactEditorMachine, type EditorEvent, type SessionEvent } from "./machine.js";

const fields = useFields({
  slots: getSlots,
  commands: getCommands,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
});

/**
 * `contacts.edit`, XState edition: the same behaviour as the `@statewalker/fsm` one; the lifecycle
 * is `contactEditorMachine` (`machine.ts`), its effects provided here.
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

  const machine = contactEditorMachine.provide({
    actors: {
      // The session: the form model and the panel, alive exactly as long as the `open` state.
      session: fromCallback<SessionEvent, Contact>(
        ({ input: { id: _id, ...base }, sendBack, receive }) => {
          const model = createContactEditorModel(base);
          const [own, release] = newRegistry();
          own(() => model.dispose());
          // Sent after the submit's notification, never inside it (the machine writes the model).
          const send = (event: EditorEvent) => queueMicrotask(() => sendBack(event));
          own(
            onSubmits(model.control.save, () =>
              send({ type: "save", draft: model.view.getDraft() }),
            ),
          );
          own(onSubmits(model.control.cancel, () => send({ type: "cancel" })));
          own(
            slots.register(panelsSlot, "contacts:editor", {
              kind: contactEditorKind,
              title: `Edit ${base.name}`,
              placement: "side",
              order: 30,
              model: model.view,
            }),
          );
          receive((event) => {
            if (event.type === "running") model.control.save.update({ running: event.value });
            else {
              const message = describeError(event.error);
              log.warn("save contact failed", { error: message });
              model.control.reportErrors({ form: message });
              notifier.notify({ message: `Save failed: ${message}`, tone: "error" });
            }
          });
          return () => void release();
        },
      ),
      save: fromPromise(
        async ({ input }) => void (await commands.call(contactsUpdate, input).promise),
      ),
    },
    actions: { saved: () => notifier.notify({ message: "Saved", tone: "success" }) },
  });
  const actor = createActor(machine).start();
  register(() => void actor.stop());

  register(
    commands.listen(contactsEditOpen, async ({ payload }) => {
      const contact = collection?.getContacts().find((c) => c.id === payload.id);
      if (!contact) throw new Error(`contact not found: ${payload.id}`);
      actor.send({ type: "open", contact });
    }),
  );
  return cleanup;
};
