import { answer, type Controller, getLogger, getSlots, useFields } from "@p5/kernel";
import { attempt, createCommitAction, drainCommits, on, session } from "@p5/kit-commit";
import { getNotificationTimeout, newNotifier } from "@p5/kit-notify";
import { trackFirst } from "@p5/kit-track";
import { dialogsSlot, menuSlot } from "@p5/shell/api";
import {
  clearCompletedKind,
  todosClearCompletedAsk,
  todosCollectionSlot,
  todosRemove,
  todosToolbarActionsSlot,
} from "@p5/todos/api";
import { createConfirmModel } from "./confirm.model.js";

const fields = useFields({ slots: getSlots, log: getLogger, timeoutMs: getNotificationTimeout });

const plural = (n: number) => `${n} completed todo${n === 1 ? "" : "s"}`;

/**
 * `todos.clear-completed`: the "Clear completed" action (toolbar + main menu) and the
 * `todos:clear-completed:ask` command, which submits the same action. The record carries the ids
 * that are done AT SUBMIT; its handler asks about exactly those in a dialog session and settles
 * when the dialog closes — so the action is `running` (and refuses) exactly as long as the dialog
 * is open, with no controller write. Clear removes those ids and notifies how many.
 */
export const activate: Controller = async (context, scope) => {
  const { slots, log: rootLog, timeoutMs } = fields(context);
  const log = rootLog.child({ bundle: "todos.clear-completed" });
  const notifier = newNotifier(slots, timeoutMs, log);
  scope.defer(() => notifier.dispose());
  const [collection, stop] = trackFirst(slots, todosCollectionSlot, (c) => [
    c.getTodos,
    c.onTodosUpdate,
  ]);
  scope.defer(stop);
  const doneIds = () => (collection() ?? []).filter((t) => t.done).map((t) => t.id);

  const action = createCommitAction({
    label: "Clear completed",
    capture: doneIds,
    when: () => doneIds().length > 0,
  });
  scope.defer(() => action.dispose());

  /** Publishes the question over `ids` in a dialog session; resolves when the dialog closes. */
  const ask = (ids: readonly string[]) =>
    session(scope, (dialog) => {
      const model = createConfirmModel(`Delete ${plural(ids.length)}?`, "Clear");
      dialog.defer(() => model.dispose());
      const drain = { scope, session: dialog, slots, log };
      drainCommits(
        drain,
        on(model.control.confirm, async (_, { task, call }) => {
          const result = await task(
            attempt(log, "clear completed", () => call(todosRemove, { ids })),
          );
          void dialog.close();
          if (!result.ok) return notifier.fail(`Clear completed failed: ${result.message}`);
          notifier.notify({ message: `Cleared ${plural(result.value)}`, tone: "success" });
        }),
      );
      drainCommits(
        drain,
        on(model.control.cancel, () => void dialog.close()),
      );
      dialog.defer(
        slots.register(dialogsSlot, "todos:clear-completed", {
          kind: clearCompletedKind,
          title: "Clear completed",
          model: model.view,
        }),
      );
    });

  drainCommits(
    { scope, slots, log },
    on(action.control, (ids, { task }) => task(ask(ids))),
  );
  // The command is one more source of the same intent: the action records it, or refuses — and a
  // refusal is the caller's answer.
  scope.defer(
    answer(slots, todosClearCompletedAsk, "todos.clear-completed", () => {
      if (action.view.submit()) return;
      throw new Error(action.view.getState().running ? "busy" : "nothing to clear");
    }),
  );
  scope.defer(
    slots.provide(todosToolbarActionsSlot, {
      id: "todos.clear-completed",
      order: 20,
      action: action.view,
    }),
  );
  scope.defer(
    slots.provide(menuSlot, {
      id: "todos.clear-completed",
      group: "todos",
      groupLabel: "Todos",
      order: 20,
      action: action.view,
    }),
  );
};
