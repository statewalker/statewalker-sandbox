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
import { startMachine } from "@kit/machine";
import { createAction, onSubmits } from "@kit/model";
import { getNotificationTimeout, newNotifier } from "@kit/notify";
import { followFirst } from "@kit/slots";
import { createEditorModel } from "./editor.model.js";
import { editorChart, type OpenEditor } from "./machine.js";

const fields = useFields({
  slots: getSlots,
  commands: getCommands,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
});

/**
 * `todos.edit`: answers `todos:edit:open` (edit mode) and `todos:compose` (create mode) with ONE
 * editor panel; Save updates or adds and closes; a failing save keeps the form with the error.
 * Contributes the main-menu item "New todo…", which calls its own `todos:compose`.
 * The editor's lifecycle is the machine in `machine.ts`.
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog, timeoutMs } = fields(context);
  const log = rootLog.child({ bundle: "todos.edit" });
  const [register, cleanup] = newRegistry();
  const notifier = newNotifier(slots, timeoutMs);
  register(() => notifier.dispose());
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

  const machine = startMachine(
    editorChart,
    {
      open: (scope) => {
        const { mode, title, id } = scope.data as OpenEditor;
        // Create mode seeds the draft with the prefilled title over an empty base.
        const model = createEditorModel(
          { title: mode === "create" ? "" : title },
          { allowClean: mode === "create", saveLabel: "Save", draft: { title } },
        );
        const [own, release] = newRegistry();
        own(() => model.dispose());
        // The commit is captured here, at submit time; a second one is dropped by the chart.
        own(
          onSubmits(model.control.save, () =>
            scope.send("save", model.view.getDraft().title.trim()),
          ),
        );
        own(onSubmits(model.control.cancel, () => scope.send("cancel")));
        own(
          slots.register(panelsSlot, "todos:editor", {
            kind: todoEditorKind,
            title: mode === "create" ? "New todo" : `Edit "${title}"`,
            placement: "side",
            order: 10,
            model: model.view,
          }),
        );
        return {
          exit: () => void release(),
          states: {
            saving: ({ data, task }) => {
              const title = data as string;
              model.control.save.update({ running: true });
              task(
                () =>
                  mode === "create"
                    ? commands.call(todosAdd, { title }).promise
                    : commands.call(todosUpdate, { id: id as string, patch: { title } }).promise,
                (result) => {
                  if (result.ok) {
                    notifier.notify({ message: "Saved", tone: "success" });
                    return "saved";
                  }
                  model.control.reportErrors({ form: `Save failed: ${result.message}` });
                  notifier.notify({ message: `Save failed: ${result.message}`, tone: "error" });
                  return "failed";
                },
              );
              return () => model.control.save.update({ running: false });
            },
          },
        };
      },
    },
    { log, name: "todos.edit" },
  );
  register(() => machine.stop());

  register(
    commands.listen(todosEditOpen, async ({ payload }) => {
      const todo = collection?.getTodos().find((t) => t.id === payload.id);
      if (!todo) throw new Error(`todo not found: ${payload.id}`);
      machine.send("edit", { mode: "edit", title: todo.title, id: todo.id } satisfies OpenEditor);
    }),
  );
  register(
    commands.listen(todosCompose, async ({ payload }) => {
      machine.send("compose", { mode: "create", title: payload.title } satisfies OpenEditor);
    }),
  );

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

  return cleanup;
};
