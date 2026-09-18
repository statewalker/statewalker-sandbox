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
  /** The last commit seq this controller took. */
  handled: number;
  cancelled: boolean;
}

/**
 * `todos.rename`, mechanism B: the rename form hands over its commit (the title frozen at submit);
 * the pass takes the newest unhandled one and settles it. "Rename…" acts on another bundle's
 * selection, which no form of this bundle owns: that commit stays a controller snapshot (A).
 * "Rename…" in `todos:selection-actions` (enabled with exactly one todo selected)
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
    const s: Session = { id, model, withdraw: () => void release(), handled: 0, cancelled: false };
    own(model.control.onCommitUpdate(() => loop.kick()));
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
    const commit = s.model.control.getCommit();
    if (!commit || commit.seq <= s.handled) return;
    s.handled = commit.seq;
    try {
      const title = commit.title.trim();
      if (title === "") return s.model.control.reportErrors({ form: "Title is required" });
      const result = await attempt(
        log,
        "rename",
        () => commands.call(todosUpdate, { id: s.id, patch: { title } }).promise,
      );
      if (!active || session !== s) return;
      if (result.ok) return close(s);
      s.model.control.reportErrors({ form: `Rename failed: ${result.message}` });
    } finally {
      s.model.control.settle(commit.seq);
    }
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
