import { dialogsSlot } from "@b/shell/api";
import {
  type TodosCollectionView,
  todoRenameKind,
  todosCollectionSlot,
  todosSelectionActionsSlot,
  todosSelectionSlot,
  todosUpdate,
} from "@b/todos/api";
import { type Controller, getCommands, getLogger, getSlots, newRegistry, useFields } from "@kernel";
import { createCommitAction, drainCommits, on } from "@kit/commit";
import { attempt } from "@kit/loop";
import { followFirst } from "@kit/slots";
import { createRenameModel } from "./rename.model.js";

const fields = useFields({ slots: getSlots, commands: getCommands, log: getLogger });

/**
 * `todos.rename`, mechanism C: "Rename…" records the selected id at submit (another bundle's
 * selection — the capture reads it); the dialog's Rename records the title at submit. Each drain
 * handles its records in commit order; `running` is the actions' own.
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog } = fields(context);
  const log = rootLog.child({ bundle: "todos.rename" });
  const [register, cleanup] = newRegistry();
  let active = true;
  let closeSession: (() => void) | undefined;
  let collection: TodosCollectionView | undefined;
  let selected: readonly string[] = [];
  const onError = (error: unknown) =>
    log.error("todos.rename: commit failed", { error: String(error) });

  const action = createCommitAction({
    label: "Rename…",
    enabled: false,
    capture: () => (selected.length === 1 ? selected[0] : undefined),
  });
  register(() => action.dispose());
  register(
    followFirst(
      slots,
      todosSelectionSlot,
      (selection) =>
        selection.onSelectedUpdate(() => {
          selected = selection.getSelected();
          action.control.update({ enabled: selected.length === 1 });
        }),
      () => action.control.update({ enabled: false }),
    ),
  );
  register(
    followFirst(slots, todosCollectionSlot, (c) => {
      collection = c;
      return () => {
        collection = undefined;
      };
    }),
  );

  function open(id: string | undefined): void {
    const todo = collection?.getTodos().find((t) => t.id === id);
    if (!todo || !active) return;
    closeSession?.();
    const model = createRenameModel(todo.title);
    const [own, release] = newRegistry();
    const close = () => {
      if (closeSession === close) closeSession = undefined;
      void release();
    };
    own(() => model.dispose());
    own(
      drainCommits(
        { isActive: () => active, onError },
        on(model.control.save, async (raw) => {
          const title = raw.trim();
          if (title === "") return model.control.reportErrors({ form: "Title is required" });
          const result = await attempt(
            log,
            "rename",
            () => commands.call(todosUpdate, { id: todo.id, patch: { title } }).promise,
          );
          if (!active) return;
          if (result.ok) return close();
          model.control.reportErrors({ form: `Rename failed: ${result.message}` });
        }),
        on(model.control.cancel, close),
      ),
    );
    own(
      slots.register(dialogsSlot, "todos:rename", {
        kind: todoRenameKind,
        title: `Rename "${todo.title}"`,
        model: model.view,
      }),
    );
    closeSession = close;
  }

  register(drainCommits({ isActive: () => active, onError }, on(action.control, open)));
  register(() => closeSession?.());
  register(
    slots.provide(todosSelectionActionsSlot, {
      id: "todos.rename",
      order: 25,
      action: action.view,
    }),
  );
  return async () => {
    active = false;
    await cleanup();
  };
};
