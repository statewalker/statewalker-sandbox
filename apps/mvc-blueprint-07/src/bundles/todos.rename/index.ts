import { type Controller, useFields } from "../../kernel/context.js";
import { defineIntent, isOutcome, openLog } from "../../kernel/log.js";
import { getSlots } from "../../kernel/slots.js";
import { intentAction } from "../../kit/action.js";
import { cell, derived } from "../../kit/cell.js";
import { followSlot } from "../../kit/follow.js";
import { dialogsSlot } from "../shell/api/index.js";
import {
  collectionSlot,
  type RenameView,
  renameKind,
  selectionActionsSlot,
  selectionSlot,
  type Todo,
  updateTodo,
} from "../todos/api/index.js";

/** Private: open the dialog for a todo; commit the title typed in it. */
const ask = defineIntent<{ id: string }>("todos.rename:ask");
const commit = defineIntent<{ id: string; title: string }>("todos.rename:commit");
const dismiss = defineIntent<void>("todos.rename:cancel");

const fields = useFields({ slots: getSlots });

/** Rename… (§14.6): a selection action, a one-field dialog, a commit-time update. */
export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const log = openLog(context, "todos.rename");
  const todos = followSlot(
    slots,
    collectionSlot,
    (c) => ({ get: c.getTodos, subscribe: c.onTodosUpdate }),
    [] as readonly Todo[],
  );
  let close: (() => void) | undefined;
  const status = cell<{ error?: string }>({});
  const offErrors = log.project((r) => {
    if (isOutcome(r, commit)) status.set(r.ok ? {} : { error: r.error });
  });

  log.handle(ask, ({ payload: { id } }) => {
    const todo = todos.get().find((t) => t.id === id);
    if (close || !todo) return;
    const draft = cell({ title: todo.title });
    status.set({});
    const ok = intentAction(log, {
      label: "Rename",
      commit: () => log.append(commit, { id, title: draft.get().title }),
    });
    const no = intentAction(log, { label: "Cancel", commit: () => log.append(dismiss, undefined) });
    const model: RenameView = Object.freeze({
      getDraft: draft.get,
      onDraftUpdate: draft.subscribe,
      getStatus: status.get,
      onStatusUpdate: status.subscribe,
      editTitle: (title: string) => draft.set({ title }),
      rename: ok.view,
      cancel: no.view,
    });
    const withdraw = slots.register(dialogsSlot, "todos:rename", {
      kind: renameKind,
      title: "Rename todo",
      model,
    });
    close = () => {
      close = undefined;
      withdraw();
      ok.dispose();
      no.dispose();
      draft.dispose();
    };
  });
  log.handle(dismiss, () => close?.());
  log.handle(commit, async ({ seq, payload }) => {
    const title = payload.title.trim();
    if (title === "") throw new Error("Title is required");
    await log.request(updateTodo, { id: payload.id, patch: { title } }, { cause: seq });
    close?.();
  });

  const selection = followSlot(
    slots,
    selectionSlot,
    (s) => ({ get: s.getSelected, subscribe: s.onSelectedUpdate }),
    [] as readonly string[],
  );
  const one = derived([selection], () => selection.get().length === 1);
  const action = intentAction(log, {
    label: "Rename…",
    guard: one,
    commit: () => log.append(ask, { id: selection.get()[0] }),
  });
  const off = slots.provide(selectionActionsSlot, { id: "rename", order: 25, action: action.view });

  return () => {
    off();
    action.dispose();
    one.dispose();
    selection.dispose();
    close?.();
    offErrors();
    log.close();
    status.dispose();
    todos.dispose();
  };
};
