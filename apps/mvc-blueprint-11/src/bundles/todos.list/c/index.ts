import { panelsSlot } from "@b/shell/api";
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
} from "@b/todos/api";
import { type Controller, getCommands, getLogger, getSlots, newRegistry, useFields } from "@kernel";
import { drainCommits, on } from "@kit/commit";
import { attempt } from "@kit/loop";
import { byOrder, followFirst } from "@kit/slots";
import { createListModel } from "./list.model.js";

const fields = useFields({ slots: getSlots, commands: getCommands, log: getLogger });

/**
 * `todos.list`, mechanism C: the list panel, the selection (published to `todos:selection`), Add (toolbar,
 * QUEUED: every submit is honoured with the title it was submitted with) and Toggle/Edit/Delete
 * (selection actions, REFUSED while running).
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog } = fields(context);
  const log = rootLog.child({ bundle: "todos.list" });
  const [register, cleanup] = newRegistry();
  let active = true;

  const model = createListModel();
  register(() => model.dispose());
  const { view, control } = model;

  // ── derived presentation: collection and action extension points ───────────────────────────
  register(
    followFirst(
      slots,
      todosCollectionSlot,
      (collection) => collection.onTodosUpdate(() => control.publishItems(collection.getTodos())),
      () => control.publishItems([]),
    ),
  );
  register(slots.observe(todosToolbarActionsSlot, (a) => control.publishToolbar(byOrder(a))));
  register(
    slots.observe(todosSelectionActionsSlot, (a) => control.publishSelectionActions(byOrder(a))),
  );

  // ── commits: each action's records carry what it means, captured at submit ─────────────────
  const { actions } = control;
  async function run(what: string, work: () => Promise<unknown>): Promise<void> {
    const result = await attempt(log, what, work);
    if (active) control.reportOutcome(result.ok ? undefined : `${what} failed: ${result.message}`);
  }
  register(
    drainCommits(
      {
        isActive: () => active,
        onError: (error) => log.error("todos.list: commit failed", { error: String(error) }),
      },
      on(actions.add, (raw) =>
        run("add", async () => {
          await commands.call(todosAdd, { title: raw.trim() }).promise;
          if (active && view.getNewTitle() === raw) control.resetNewTitle();
        }),
      ),
      on(actions.toggle, (targets) =>
        run("toggle", async () => {
          for (const t of targets) {
            await commands.call(todosUpdate, { id: t.id, patch: { done: !t.done } }).promise;
          }
        }),
      ),
      on(actions.edit, ([id]) => run("edit", () => commands.call(todosEditOpen, { id }).promise)),
      on(actions.remove, (ids) => run("delete", () => commands.call(todosRemove, { ids }).promise)),
    ),
  );

  // ── publications ─────────────────────────────────────────────────────────────────────────
  register(
    slots.register(panelsSlot, "todos:list", {
      kind: todoListKind,
      title: "Todos",
      placement: "main",
      order: 10,
      model: view,
    }),
  );
  register(slots.provide(todosSelectionSlot, model.selection));
  const { add, toggle, edit, remove } = view.actions;
  register(slots.provide(todosToolbarActionsSlot, { id: "todos.add", order: 10, action: add }));
  register(
    slots.provide(todosSelectionActionsSlot, { id: "todos.toggle", order: 10, action: toggle }),
  );
  register(slots.provide(todosSelectionActionsSlot, { id: "todos.edit", order: 20, action: edit }));
  register(
    slots.provide(todosSelectionActionsSlot, { id: "todos.delete", order: 30, action: remove }),
  );

  return async () => {
    active = false;
    await cleanup();
  };
};
