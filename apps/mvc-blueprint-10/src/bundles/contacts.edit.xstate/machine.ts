import type { Contact, ContactDraft } from "@b/contacts/api";
import { type ActorRefFrom, assign, fromCallback, fromPromise, sendTo, setup } from "xstate";

/** Events the machine receives: from the command listener (`open`) and from the session (`save`, `cancel`). */
export type EditorEvent =
  | { type: "open"; contact: Contact }
  | { type: "save"; draft: ContactDraft }
  | { type: "cancel" };

/** What the machine tells the session (the actor that owns the model and the panel). */
export type SessionEvent = { type: "running"; value: boolean } | { type: "failed"; error: unknown };

/**
 * `contacts.edit` in XState v5. `open` is (re)entered by every `open` event and invokes the
 * `session` actor — it owns the form model and the panel, and is stopped (so the panel is
 * withdrawn) when `open` exits OR when the whole actor stops. `saving` invokes `save`; a `save`
 * while saving has no handler and is ignored: Save is REFUSED while running. The implementations
 * of `session`, `save` and `saved` are provided by the controller (`.provide`).
 */
export const contactEditorMachine = setup({
  types: { context: {} as { id: string }, events: {} as EditorEvent },
  actors: {
    session: fromCallback<SessionEvent, Contact>(() => {
      throw new Error("provided by the controller");
    }),
    save: fromPromise<void, { id: string; patch: ContactDraft }>(async () => {
      throw new Error("provided by the controller");
    }),
  },
  actions: { saved: () => {} },
}).createMachine({
  id: "contactsEdit", // a "." here would be read as a path by "#…" targets
  context: { id: "" },
  initial: "closed",
  on: { open: { target: ".open", reenter: true } },
  states: {
    closed: {},
    open: {
      entry: assign({
        id: ({ event }) => (event as Extract<EditorEvent, { type: "open" }>).contact.id,
      }),
      invoke: {
        id: "session",
        src: "session",
        input: ({ event }) => (event as Extract<EditorEvent, { type: "open" }>).contact,
      },
      on: { cancel: "closed" },
      initial: "editing",
      states: {
        editing: {
          entry: sendTo("session", { type: "running", value: false }),
          on: { save: "saving" },
        },
        saving: {
          entry: sendTo("session", { type: "running", value: true }),
          invoke: {
            src: "save",
            input: ({ context, event }) => ({
              id: context.id,
              patch: (event as Extract<EditorEvent, { type: "save" }>).draft,
            }),
            onDone: { target: "#contactsEdit.closed", actions: "saved" },
            onError: {
              target: "editing",
              actions: sendTo("session", ({ event }) => ({
                type: "failed" as const,
                error: event.error,
              })),
            },
          },
        },
      },
    },
  },
});

export type ContactEditorActor = ActorRefFrom<typeof contactEditorMachine>;
