import { type Controller, useFields } from "../../kernel/context.js";
import { defineIntent, isIntent, isOutcome, openLog } from "../../kernel/log.js";
import { getSlots } from "../../kernel/slots.js";
import { intentAction } from "../../kit/action.js";
import { cell, derived } from "../../kit/cell.js";
import { followSlot } from "../../kit/follow.js";
import {
  type Contact,
  type ContactDraft,
  type ContactEditorView,
  contactEditorKind,
  directorySlot,
  openContactEditor,
  selectionActionsSlot,
  selectionSlot,
  updateContact,
} from "../contacts/api/index.js";
import { menuSlot, notify, panelsSlot } from "../shell/api/index.js";

/** Private: the editor's gestures; `save` carries the whole draft as committed. */
const save = defineIntent<{ id: string; draft: ContactDraft }>("contacts.edit:save");
const cancel = defineIntent<{ id: string }>("contacts.edit:cancel");

const fields = useFields({ slots: getSlots });

export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const log = openLog(context, "contacts.edit");
  const directory = followSlot(
    slots,
    directorySlot,
    (d) => ({ get: d.getContacts, subscribe: d.onContactsUpdate }),
    [] as readonly Contact[],
  );
  /** open editors by contact id (one session per contact: a second open joins it) */
  const editors = new Map<
    string,
    { status: ReturnType<typeof cell<{ error?: string }>>; close(): void }
  >();
  const saves = new Map<number, string>();
  const offErrors = log.project((record) => {
    if (isIntent(record, save)) saves.set(record.seq, record.payload.id);
    if (!isOutcome(record, save)) return;
    const editor = editors.get(saves.get(record.cause) ?? "");
    saves.delete(record.cause);
    editor?.status.set(record.ok ? {} : { error: record.error });
  });

  log.handle(openContactEditor, ({ payload: { id } }) => {
    if (editors.has(id)) return;
    const stored = directory.get().find((c) => c.id === id);
    if (!stored) throw new Error(`no contact ${id}`);
    const draft = cell<ContactDraft>({
      name: stored.name,
      email: stored.email,
      phone: stored.phone,
    });
    const status = cell<{ error?: string }>({});
    const saveAction = intentAction(log, {
      label: "Save",
      commit: () => log.append(save, { id, draft: draft.get() }),
    });
    const cancelAction = intentAction(log, {
      label: "Cancel",
      commit: () => log.append(cancel, { id }),
    });
    const model: ContactEditorView = Object.freeze({
      getDraft: draft.get,
      onDraftUpdate: draft.subscribe,
      getStatus: status.get,
      onStatusUpdate: status.subscribe,
      editField: <K extends keyof ContactDraft>(field: K, value: ContactDraft[K]) =>
        draft.patch({ [field]: value } as Partial<ContactDraft>),
      save: saveAction.view,
      cancel: cancelAction.view,
    });
    const withdraw = slots.register(panelsSlot, `contacts:editor:${id}`, {
      kind: contactEditorKind,
      title: `Edit ${stored.name}`,
      placement: "side",
      order: 1,
      model,
    });
    editors.set(id, {
      status,
      close() {
        editors.delete(id);
        withdraw();
        saveAction.dispose();
        cancelAction.dispose();
        draft.dispose();
        status.dispose();
      },
    });
  });
  log.handle(cancel, ({ payload }) => editors.get(payload.id)?.close());
  log.handle(save, async ({ seq, payload }) => {
    try {
      await log.request(updateContact, { id: payload.id, patch: payload.draft }, { cause: seq });
    } catch (error) {
      log.append(notify, { message: `Could not save: ${(error as Error).message}`, tone: "error" });
      throw error; // the outcome record carries it to the form
    }
    editors.get(payload.id)?.close();
    log.append(notify, { message: "Saved", tone: "success" });
  });

  // "Edit" (selection action) and "Edit contact" (main menu): enabled while a contact is selected.
  const selection = followSlot(
    slots,
    selectionSlot,
    (s) => ({ get: s.getSelected, subscribe: s.onSelectedUpdate }),
    undefined as Contact | undefined,
  );
  const some = derived([selection], () => selection.get() !== undefined);
  const openSelected = () => {
    const contact = selection.get();
    return contact ? log.append(openContactEditor, { id: contact.id }) : undefined;
  };
  const edit = intentAction(log, { label: "Edit", guard: some, commit: openSelected });
  const menu = intentAction(log, { label: "Edit contact", guard: some, commit: openSelected });
  const offs = [
    slots.provide(selectionActionsSlot, { id: "edit", order: 0, action: edit.view }),
    slots.provide(menuSlot, {
      id: "contacts.edit",
      group: "contacts",
      groupLabel: "Contacts",
      order: 0,
      action: menu.view,
    }),
  ];

  return () => {
    for (const off of offs) off();
    edit.dispose();
    menu.dispose();
    some.dispose();
    selection.dispose();
    for (const editor of [...editors.values()]) editor.close();
    offErrors();
    log.close();
    directory.dispose();
  };
};
