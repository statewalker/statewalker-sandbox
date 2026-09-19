import { answer, type Controller, getLogger, getSlots, type Scope, useFields } from "@p5/kernel";
import { attempt, createCommitAction, drainCommits, on } from "@p5/kit-commit";
import { createForm } from "@p5/kit-form";
import { getNotificationTimeout, newNotifier } from "@p5/kit-notify";
import { menuSlot, panelsSlot } from "@p5/shell/api";
import {
  type TitleDraft,
  todoEditorKind,
  todosAdd,
  todosCollectionSlot,
  todosCompose,
  todosEditOpen,
  todosUpdate,
} from "@p5/todos/api";

const fields = useFields({ slots: getSlots, log: getLogger, timeoutMs: getNotificationTimeout });

/**
 * `todos.edit`: answers `todos:edit:open` (edit mode) and `todos:compose` (create mode) with ONE
 * editor session; Save updates or adds and closes; a failing save keeps the form with the error.
 * Contributes the main-menu item "New todo…", which calls its own `todos:compose`.
 * Save is REFUSED while running; Cancel is its own lane. Outcomes as in `contacts.edit`.
 */
export const activate: Controller = async (context, scope) => {
  const { slots, log: rootLog, timeoutMs } = fields(context);
  const log = rootLog.child({ bundle: "todos.edit" });
  const notifier = newNotifier(slots, timeoutMs, log);
  scope.defer(() => notifier.dispose());

  let session: Scope | undefined; // the open editor; a new open replaces it
  function open(mode: "edit" | "create", title: string, id?: string): void {
    void session?.close();
    const editor = (session = scope.child());
    // Create mode seeds the draft with the prefilled title over an empty base (a whole-form seed).
    const model = createForm<TitleDraft>(
      { title: mode === "create" ? "" : title },
      { allowClean: mode === "create", draft: { title }, valid: (d) => d.title.trim() !== "" },
    );
    editor.defer(() => model.dispose());
    const drain = { scope, session: editor, slots, log };
    drainCommits(
      drain,
      on(model.control.save, async (draft, { task, call }) => {
        const next = draft.title.trim();
        const result = await task(
          attempt(log, "save", () =>
            mode === "create"
              ? call(todosAdd, { title: next })
              : call(todosUpdate, { id: id as string, patch: { title: next } }),
          ),
        );
        if (!result.ok) {
          model.control.reportErrors({ form: `Save failed: ${result.message}` });
          return notifier.fail(`Could not save "${next}": ${result.message}`);
        }
        notifier.notify({ message: `Saved "${next}"`, tone: "success" });
        void editor.close();
      }),
    );
    drainCommits(
      drain,
      on(model.control.cancel, () => void editor.close()),
    );
    editor.defer(
      slots.register(panelsSlot, "todos:editor", {
        kind: todoEditorKind,
        title: mode === "create" ? "New todo" : `Edit "${title}"`,
        placement: "side",
        order: 10,
        model: model.view,
      }),
    );
  }

  scope.defer(
    answer(slots, todosEditOpen, ({ payload }) => {
      const collection = slots.getSnapshot(todosCollectionSlot)[0]; // a one-shot read
      const todo = collection?.getTodos().find((t) => t.id === payload.id);
      if (!todo) throw new Error(`todo not found: ${payload.id}`);
      open("edit", todo.title, todo.id);
    }),
  );
  scope.defer(answer(slots, todosCompose, ({ payload }) => open("create", payload.title)));

  // "New todo…" in the main menu: calls its own command, like any other caller would.
  const newTodo = createCommitAction({ label: "New todo…", capture: () => undefined });
  scope.defer(() => newTodo.dispose());
  drainCommits(
    { scope, slots, log },
    on(newTodo.control, async (_, { task, call }) => {
      const result = await task(attempt(log, "compose", () => call(todosCompose, { title: "" })));
      if (!result.ok) notifier.fail(`Could not open a new todo: ${result.message}`);
    }),
  );
  scope.defer(
    slots.provide(menuSlot, {
      id: "todos.new",
      group: "todos",
      groupLabel: "Todos",
      order: 10,
      action: newTodo.view,
    }),
  );
};
