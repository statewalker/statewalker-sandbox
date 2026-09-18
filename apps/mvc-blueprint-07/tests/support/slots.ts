import * as contactsApi from "../../src/bundles/contacts/api/index.js";
import * as shellApi from "../../src/bundles/shell/api/index.js";
import { reactRenderersSlot } from "../../src/bundles/shell/api/react.js";
import * as todosApi from "../../src/bundles/todos/api/index.js";
import type { Slots } from "../../src/kernel/slots.js";

/** Every slot the application declares, read from the API modules. */
export const ALL_SLOTS = [
  shellApi.headerSlot,
  shellApi.menuSlot,
  shellApi.panelsSlot,
  shellApi.dialogsSlot,
  shellApi.notificationsSlot,
  reactRenderersSlot,
  todosApi.collectionSlot,
  todosApi.selectionSlot,
  todosApi.toolbarActionsSlot,
  todosApi.selectionActionsSlot,
  contactsApi.directorySlot,
  contactsApi.selectionSlot,
  contactsApi.selectionActionsSlot,
];

export const nonEmptySlots = (slots: Slots) =>
  ALL_SLOTS.filter((slot) => {
    const snapshot = slots.getSnapshot(slot as never) as
      | readonly unknown[]
      | ReadonlyMap<string, unknown>;
    return (
      (Array.isArray(snapshot)
        ? snapshot.length
        : (snapshot as ReadonlyMap<string, unknown>).size) > 0
    );
  }).map((s) => s.key);
