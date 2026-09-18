import { type Controller, useFields } from "../../kernel/context.js";
import { defineIntent, openLog } from "../../kernel/log.js";
import { getSlots } from "../../kernel/slots.js";
import { intentAction } from "../../kit/action.js";
import { cell, derived } from "../../kit/cell.js";
import { followSlot } from "../../kit/follow.js";
import { dialogsSlot, menuSlot, notify } from "../shell/api/index.js";
import {
  askClearCompleted,
  type ClearCompletedView,
  clearCompletedKind,
  collectionSlot,
  removeTodos,
  type Todo,
  type TodosCounts,
  toolbarActionsSlot,
} from "../todos/api/index.js";

/** Private: the dialog's two gestures. `confirm` carries the ids that were done WHEN ASKED. */
const confirm = defineIntent<{ ids: readonly string[] }, number>("todos.clear-completed:confirm");
const dismiss = defineIntent<void>("todos.clear-completed:cancel");

const DIALOG = "todos:clear-completed";
const fields = useFields({ slots: getSlots });

export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const log = openLog(context, "todos.clear-completed");
  const todos = followSlot(
    slots,
    collectionSlot,
    (c) => ({ get: c.getTodos, subscribe: c.onTodosUpdate }),
    [] as readonly Todo[],
  );
  const counts = followSlot(
    slots,
    collectionSlot,
    (c) => ({ get: c.getCounts, subscribe: c.onCountsUpdate }),
    { open: 0, done: 0 } as TodosCounts,
  );
  let closeDialog: (() => void) | undefined;

  log.handle(askClearCompleted, () => {
    if (closeDialog) return; // one dialog; a second ask joins it
    const ids = todos
      .get()
      .filter((t) => t.done)
      .map((t) => t.id); // captured at ask time
    const state = cell({ count: ids.length });
    const ok = intentAction(log, { label: "Clear", commit: () => log.append(confirm, { ids }) });
    const no = intentAction(log, { label: "Cancel", commit: () => log.append(dismiss, undefined) });
    const model: ClearCompletedView = Object.freeze({
      getState: state.get,
      onStateUpdate: state.subscribe,
      confirm: ok.view,
      cancel: no.view,
    });
    const withdraw = slots.register(dialogsSlot, DIALOG, {
      kind: clearCompletedKind,
      title: "Clear completed",
      model,
    });
    closeDialog = () => {
      closeDialog = undefined;
      withdraw();
      ok.dispose();
      no.dispose();
      state.dispose();
    };
  });
  log.handle(dismiss, () => closeDialog?.());
  log.handle(confirm, async ({ seq, payload }) => {
    const removed = await log.request(removeTodos, { ids: payload.ids }, { cause: seq });
    closeDialog?.();
    const n = removed.length;
    log.append(notify, {
      message: `Removed ${n} completed todo${n === 1 ? "" : "s"}`,
      tone: "success",
    });
    return n;
  });

  const anyDone = derived([counts], () => counts.get().done > 0);
  const ask = (label: string) =>
    intentAction(log, {
      label,
      guard: anyDone,
      commit: () => log.append(askClearCompleted, undefined),
    });
  const toolbar = ask("Clear completed");
  const menu = ask("Clear completed");
  const offs = [
    slots.provide(toolbarActionsSlot, { id: "clear-completed", order: 10, action: toolbar.view }),
    slots.provide(menuSlot, {
      id: "todos.clear-completed",
      group: "todos",
      groupLabel: "Todos",
      order: 10,
      action: menu.view,
    }),
  ];

  return () => {
    for (const off of offs) off();
    toolbar.dispose();
    menu.dispose();
    anyDone.dispose();
    closeDialog?.();
    log.close();
    counts.dispose();
    todos.dispose();
  };
};
