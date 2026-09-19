import { type Controller, call, getLogger, getSlots, useFields } from "@p5/kernel";
import { attempt, drainCommits, on, type Turn } from "@p5/kit-commit";
import { byOrder, followFirst } from "@p5/kit-slots";
import { panelsSlot } from "@p5/shell/api";
import {
  todoListKind,
  todosAdd,
  todosCollectionSlot,
  todosEditOpen,
  todosRemove,
  todosSelectionActionsSlot,
  todosSelectionSlot,
  todosToolbarActionsSlot,
  todosUpdate,
} from "@p5/todos/api";
import { createListModel } from "./list.model.js";

const fields = useFields({ slots: getSlots, log: getLogger });

/**
 * `todos.list`: the list panel, the selection (published to `todos:selection`), Add (toolbar,
 * QUEUED: every submit is honoured with the title it was submitted with) and Toggle/Edit/Delete
 * (selection actions, REFUSED while running). Each record carries what its commit means.
 */
export const activate: Controller = async (context, scope) => {
  const { slots, log: rootLog } = fields(context);
  const log = rootLog.child({ bundle: "todos.list" });
  const model = createListModel();
  scope.defer(() => model.dispose());
  const { view, control } = model;

  // ── derived presentation: collection and action extension points ───────────────────────────
  scope.defer(
    followFirst(
      slots,
      todosCollectionSlot,
      (collection) => collection.onTodosUpdate(() => control.publishItems(collection.getTodos())),
      () => control.publishItems([]),
    ),
  );
  scope.defer(slots.observe(todosToolbarActionsSlot, (a) => control.publishToolbar(byOrder(a))));
  scope.defer(
    slots.observe(todosSelectionActionsSlot, (a) => control.publishSelectionActions(byOrder(a))),
  );

  // ── commits ──────────────────────────────────────────────────────────────────────────────
  const run = async (what: string, { task }: Turn, work: () => Promise<unknown>) => {
    const result = await task(attempt(log, what, work));
    control.reportOutcome(result.ok ? undefined : `${what} failed: ${result.message}`);
    return result.ok;
  };
  const { actions } = control;
  drainCommits(
    scope,
    log,
    on(actions.add, async (raw, turn) => {
      const added = await run(
        "add",
        turn,
        () => call(slots, todosAdd, { title: raw.trim() }).promise,
      );
      // Clear the input only if it still holds what was added (typing went on meanwhile).
      if (added && view.getNewTitle() === raw) control.resetNewTitle();
    }),
    on(actions.toggle, (targets, turn) =>
      run("toggle", turn, async () => {
        for (const t of targets)
          await turn.task(call(slots, todosUpdate, { id: t.id, patch: { done: !t.done } }).promise);
      }),
    ),
    on(actions.edit, ([id], turn) =>
      run("edit", turn, () => call(slots, todosEditOpen, { id }).promise),
    ),
    on(actions.remove, (ids, turn) =>
      run("delete", turn, () => call(slots, todosRemove, { ids }).promise),
    ),
  );

  // ── publications ─────────────────────────────────────────────────────────────────────────
  scope.defer(
    slots.register(panelsSlot, "todos:list", {
      kind: todoListKind,
      title: "Todos",
      placement: "main",
      order: 10,
      model: view,
    }),
  );
  scope.defer(slots.provide(todosSelectionSlot, model.selection));
  const { add, toggle, edit, remove } = view.actions;
  scope.defer(slots.provide(todosToolbarActionsSlot, { id: "todos.add", order: 10, action: add }));
  scope.defer(
    slots.provide(todosSelectionActionsSlot, { id: "todos.toggle", order: 10, action: toggle }),
  );
  scope.defer(
    slots.provide(todosSelectionActionsSlot, { id: "todos.edit", order: 20, action: edit }),
  );
  scope.defer(
    slots.provide(todosSelectionActionsSlot, { id: "todos.delete", order: 30, action: remove }),
  );
};
