import { type Controller, call, getLogger, getSlots, useFields } from "@p5/kernel";
import { attempt, createCommitAction, drainCommits, on } from "@p5/kit-commit";
import { createForm } from "@p5/kit-form";
import { getNotificationTimeout, newNotifier } from "@p5/kit-notify";
import { trackFirst } from "@p5/kit-track";
import { dialogsSlot } from "@p5/shell/api";
import {
  type TitleDraft,
  type Todo,
  todoRenameKind,
  todosCollectionSlot,
  todosSelectionActionsSlot,
  todosSelectionSlot,
  todosUpdate,
} from "@p5/todos/api";

const fields = useFields({ slots: getSlots, log: getLogger, timeoutMs: getNotificationTimeout });

/**
 * `todos.rename`: "Rename…" in `todos:selection-actions`, enabled with exactly one todo selected
 * (read from `todos:selection`). Its record carries that todo at submit and opens a dialog
 * session (the action runs until it closes); the dialog's Rename commits the title captured at
 * submit through `todos:update`; an empty title is refused with a form error.
 */
export const activate: Controller = async (context, scope) => {
  const { slots, log, timeoutMs } = fields(context);
  const notifier = newNotifier(slots, timeoutMs);
  scope.defer(() => notifier.dispose());
  const [selected, offSelected] = trackFirst(slots, todosSelectionSlot, (s) => [
    s.getSelected,
    s.onSelectedUpdate,
  ]);
  const [todos, offTodos] = trackFirst(slots, todosCollectionSlot, (c) => [
    c.getTodos,
    c.onTodosUpdate,
  ]);
  scope.defer(offSelected);
  scope.defer(offTodos);
  const one = () => {
    const ids = selected() ?? [];
    return ids.length === 1 ? todos()?.find((t) => t.id === ids[0]) : undefined;
  };
  const action = createCommitAction({
    label: "Rename…",
    when: () => one() !== undefined,
    capture: () => one() as Todo,
  });
  scope.defer(() => action.dispose());

  /** The dialog session over `todo`; resolves when it closes. */
  const rename = (todo: Todo) =>
    new Promise<void>((closed) => {
      const dialog = scope.child();
      dialog.defer(closed);
      const form = createForm<TitleDraft>({ title: todo.title }, { saveLabel: "Rename" });
      dialog.defer(() => form.dispose());
      drainCommits(
        dialog,
        log,
        on(form.control.save, async ({ title }, { task }) => {
          const next = title.trim();
          if (next === "") return form.control.reportErrors({ form: "Title is required" });
          const result = await task(
            attempt(
              log,
              "rename",
              () => call(slots, todosUpdate, { id: todo.id, patch: { title: next } }).promise,
            ),
          );
          if (result.ok) return void dialog.close();
          form.control.reportErrors({ form: `Rename failed: ${result.message}` });
          notifier.notify({ message: `Could not rename "${todo.title}"`, tone: "error" });
        }),
        on(form.control.cancel, () => void dialog.close()),
      );
      dialog.defer(
        slots.register(dialogsSlot, "todos:rename", {
          kind: todoRenameKind,
          title: `Rename "${todo.title}"`,
          model: form.view,
        }),
      );
    });

  drainCommits(
    scope,
    log,
    on(action.control, (todo, { task }) => task(rename(todo))),
  );
  scope.defer(
    slots.provide(todosSelectionActionsSlot, {
      id: "todos.rename",
      order: 25,
      action: action.view,
    }),
  );
};
