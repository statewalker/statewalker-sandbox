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
import { attempt, newUpdateLoop } from "@kit/loop";
import { createAction, onSubmits } from "@kit/model";
import { followFirst } from "@kit/slots";
import { createRenameModel, type RenameModel } from "./rename.model.js";

const fields = useFields({ slots: getSlots, commands: getCommands, log: getLogger });

interface Session {
  readonly id: string;
  readonly model: RenameModel;
  readonly withdraw: () => void;
  commit?: string;
  cancelled: boolean;
}

/**
 * `todos.rename`: "Rename…" in `todos:selection-actions` (enabled with exactly one todo selected)
 * publishes a dialog; Rename updates the title AT COMMIT TIME and withdraws the dialog; an empty
 * title is refused with a form error.
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog } = fields(context);
  const log = rootLog.child({ bundle: "todos.rename" });
  const [register, cleanup] = newRegistry();
  let active = true;
  let session: Session | undefined;
  let collection: TodosCollectionView | undefined;
  let selected: readonly string[] = [];
  let openOwed: string | undefined;

  const action = createAction({ label: "Rename…", enabled: false });
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

  const loop = newUpdateLoop(pass, {
    isActive: () => active,
    onError: (error) => log.error("todos.rename: pass failed", { error: String(error) }),
  });

  function close(s: Session | undefined): void {
    if (!s) return;
    if (session === s) session = undefined;
    s.withdraw();
  }

  function open(id: string): void {
    const todo = collection?.getTodos().find((t) => t.id === id);
    if (!todo || !active) return;
    close(session);
    const model = createRenameModel(todo.title);
    const [own, release] = newRegistry();
    own(() => model.dispose());
    const s: Session = { id, model, withdraw: () => void release(), cancelled: false };
    own(
      onSubmits(model.control.save, () => {
        s.commit ??= model.view.getDraft().title;
        loop.kick();
      }),
    );
    own(
      onSubmits(model.control.cancel, () => {
        s.cancelled = true;
        loop.kick();
      }),
    );
    own(
      slots.register(dialogsSlot, "todos:rename", {
        kind: todoRenameKind,
        title: `Rename "${todo.title}"`,
        model: model.view,
      }),
    );
    session = s;
  }

  async function pass(): Promise<void> {
    if (openOwed !== undefined) {
      const id = openOwed;
      openOwed = undefined;
      open(id);
    }
    const s = session;
    if (!s) return;
    if (s.cancelled) return close(s);
    if (s.commit === undefined) return;
    const title = s.commit.trim();
    s.commit = undefined;
    if (title === "") return s.model.control.reportErrors({ form: "Title is required" });
    s.model.control.save.update({ running: true });
    const result = await attempt(
      log,
      "rename",
      () => commands.call(todosUpdate, { id: s.id, patch: { title } }).promise,
    );
    if (!active || session !== s) return;
    s.model.control.save.update({ running: false });
    if (result.ok) return close(s);
    s.model.control.reportErrors({ form: `Rename failed: ${result.message}` });
  }

  register(
    onSubmits(action.control, () => {
      openOwed = selected.length === 1 ? selected[0] : undefined; // at commit time
      loop.kick();
    }),
  );
  register(() => close(session));
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
