import { panelsSlot } from "@b/shell/api";
import {
  type Todo,
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
import {
  type ActionControl,
  type Controller,
  getCommands,
  getLogger,
  getSlots,
  newRegistry,
  useFields,
} from "@kernel";
import { attempt, newUpdateLoop } from "@kit/loop";
import { onSubmits } from "@kit/model";
import { byOrder, firstOf } from "@kit/slots";
import { createListModel } from "./list.model.js";

const EMPTY: readonly Todo[] = Object.freeze([]);
const fields = useFields({ slots: getSlots, commands: getCommands, log: getLogger });

/** What a commit acts on, captured synchronously in the submit listener. */
interface Snapshot {
  readonly selection: readonly string[];
  readonly items: readonly Todo[];
}

/**
 * `todos.list`: the list panel, the selection (published to `todos:selection`), Add (toolbar,
 * QUEUED: every submit is honoured with the title it was submitted with) and Toggle/Edit/Delete
 * (selection actions, REFUSED while running).
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog } = fields(context);
  const log = rootLog.child({ bundle: "todos.list" });
  const [register, cleanup] = newRegistry();
  let active = true;

  // P4: the list's items are derived from the collection on the shared substrate.
  const [collection, stopCollection] = firstOf(slots, todosCollectionSlot);
  register(stopCollection);
  const model = createListModel(() => collection()?.todos() ?? EMPTY);
  register(() => model.dispose());
  const { view, control } = model;

  // ── derived presentation: the action extension points ────────────────────────────────────
  register(slots.observe(todosToolbarActionsSlot, (a) => control.publishToolbar(byOrder(a))));
  register(
    slots.observe(todosSelectionActionsSlot, (a) => control.publishSelectionActions(byOrder(a))),
  );

  // ── commits ──────────────────────────────────────────────────────────────────────────────
  const adds: string[] = [];
  const pending: { toggle?: Snapshot; edit?: Snapshot; remove?: Snapshot } = {};
  const snapshot = (): Snapshot => ({ selection: view.getSelection(), items: view.getItems() });
  const loop = newUpdateLoop(pass, {
    isActive: () => active,
    onError: (error) => log.error("todos.list: pass failed", { error: String(error) }),
  });
  const { actions } = control;
  register(
    onSubmits(actions.add, (n) => {
      for (let i = 0; i < n; i++) adds.push(view.getNewTitle());
      loop.kick();
    }),
  );
  for (const key of ["toggle", "edit", "remove"] as const) {
    register(
      onSubmits(actions[key], () => {
        // Two submits in one tick are one commit, on the state of the first.
        pending[key] ??= snapshot();
        loop.kick();
      }),
    );
  }

  async function run(action: ActionControl, what: string, work: () => Promise<unknown>) {
    action.update({ running: true });
    const result = await attempt(log, what, work);
    if (!active) return;
    action.update({ running: false });
    control.reportOutcome(result.ok ? undefined : `${what} failed: ${result.message}`);
  }

  async function pass(): Promise<void> {
    while (adds.length > 0 && active) {
      const raw = adds.shift() as string;
      const title = raw.trim();
      if (title === "") continue;
      await run(actions.add, "add", async () => {
        await commands.call(todosAdd, { title }).promise;
        if (active && view.getNewTitle() === raw) control.resetNewTitle();
      });
    }
    const toggle = pending.toggle;
    pending.toggle = undefined;
    if (toggle && active) {
      const selected = new Set(toggle.selection);
      const targets = toggle.items.filter((t) => selected.has(t.id));
      await run(actions.toggle, "toggle", async () => {
        for (const t of targets) {
          await commands.call(todosUpdate, { id: t.id, patch: { done: !t.done } }).promise;
        }
      });
    }
    const edit = pending.edit;
    pending.edit = undefined;
    if (edit && active && edit.selection.length === 1) {
      const id = edit.selection[0];
      await run(actions.edit, "edit", () => commands.call(todosEditOpen, { id }).promise);
    }
    const remove = pending.remove;
    pending.remove = undefined;
    if (remove && active && remove.selection.length > 0) {
      const ids = remove.selection;
      await run(actions.remove, "delete", () => commands.call(todosRemove, { ids }).promise);
    }
  }

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
