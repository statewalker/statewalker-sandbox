import { menuSlot, panelsSlot } from "@b/shell/api";
import {
  type TodosCollectionView,
  todoEditorKind,
  todosAdd,
  todosCollectionSlot,
  todosCompose,
  todosEditOpen,
  todosUpdate,
} from "@b/todos/api";
import { type Controller, getCommands, getLogger, getSlots, newRegistry, useFields } from "@kernel";
import { attempt, newUpdateLoop } from "@kit/loop";
import { createAction, onSubmits } from "@kit/model";
import { getNotificationTimeout, newNotifier } from "@kit/notify";
import { followFirst } from "@kit/slots";
import { createEditorModel, type EditorModel } from "./editor.model.js";

const fields = useFields({
  slots: getSlots,
  commands: getCommands,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
});

interface Session {
  readonly mode: "edit" | "create";
  readonly id?: string;
  readonly model: EditorModel;
  readonly withdraw: () => void;
  /** Save's commit, captured at submit time. */
  commit?: { readonly title: string };
  cancelled: boolean;
}

const PANEL_ID = "todos:editor";

/**
 * `todos.edit`: answers `todos:edit:open` (edit mode) and `todos:compose` (create mode) with ONE
 * editor panel; Save updates or adds and closes; a failing save keeps the form with the error.
 * Contributes the main-menu item "New todo…", which calls its own `todos:compose`.
 * Save is REFUSED while running (`running: true`).
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog, timeoutMs } = fields(context);
  const log = rootLog.child({ bundle: "todos.edit" });
  const [register, cleanup] = newRegistry();
  const notifier = newNotifier(slots, timeoutMs);
  register(() => notifier.dispose());
  let active = true;
  let session: Session | undefined;
  let collection: TodosCollectionView | undefined;
  register(
    followFirst(
      slots,
      todosCollectionSlot,
      (c) => {
        collection = c;
        return () => {};
      },
      () => {
        collection = undefined;
      },
    ),
  );

  const loop = newUpdateLoop(pass, {
    isActive: () => active,
    onError: (error) => log.error("todos.edit: pass failed", { error: String(error) }),
  });

  function close(s: Session | undefined): void {
    if (!s) return;
    if (session === s) session = undefined;
    s.withdraw();
  }

  function open(mode: "edit" | "create", title: string, id?: string): void {
    close(session);
    // Create mode seeds the draft with the prefilled title over an empty base (a whole-form seed).
    const model = createEditorModel(
      { title: mode === "create" ? "" : title },
      { allowClean: mode === "create", saveLabel: "Save", draft: { title } },
    );
    const [own, release] = newRegistry();
    own(() => model.dispose());
    const s: Session = { mode, id, model, withdraw: () => void release(), cancelled: false };
    own(
      onSubmits(model.control.save, () => {
        s.commit ??= { title: model.view.getDraft().title };
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
      slots.register(panelsSlot, PANEL_ID, {
        kind: todoEditorKind,
        title: mode === "create" ? "New todo" : `Edit "${title}"`,
        placement: "side",
        order: 10,
        model: model.view,
      }),
    );
    session = s;
  }

  async function pass(): Promise<void> {
    const s = session;
    if (!s) return;
    if (s.cancelled) return close(s);
    const commit = s.commit;
    if (!commit) return;
    s.commit = undefined;
    const title = commit.title.trim();
    const { save } = s.model.control;
    save.update({ running: true });
    const result = await attempt(log, "save", () =>
      s.mode === "create"
        ? commands.call(todosAdd, { title }).promise
        : commands.call(todosUpdate, { id: s.id as string, patch: { title } }).promise,
    );
    if (!active) return;
    // The write landed: say so even if this session was replaced meanwhile.
    if (result.ok) notifier.notify({ message: "Saved", tone: "success" });
    if (session !== s) return;
    save.update({ running: false });
    if (result.ok) return close(s);
    s.model.control.reportErrors({ form: `Save failed: ${result.message}` });
    notifier.notify({ message: `Save failed: ${result.message}`, tone: "error" });
  }

  register(
    commands.listen(todosEditOpen, async ({ payload }) => {
      const todo = collection?.getTodos().find((t) => t.id === payload.id);
      if (!todo) throw new Error(`todo not found: ${payload.id}`);
      if (active) open("edit", todo.title, todo.id);
    }),
  );
  register(
    commands.listen(todosCompose, async ({ payload }) => {
      if (active) open("create", payload.title);
    }),
  );
  register(() => close(session));

  // "New todo…" in the main menu: calls its own command, like any other caller would.
  const newTodo = createAction({ label: "New todo…" });
  register(() => newTodo.dispose());
  register(
    onSubmits(newTodo.control, () => {
      void commands
        .call(todosCompose, { title: "" })
        .promise.catch((error) => log.warn("compose failed", { error: String(error) }));
    }),
  );
  register(
    slots.provide(menuSlot, {
      id: "todos.new",
      group: "todos",
      groupLabel: "Todos",
      order: 10,
      action: newTodo.view,
    }),
  );

  return async () => {
    active = false;
    await cleanup();
  };
};
