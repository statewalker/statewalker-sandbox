import { dialogsSlot, menuSlot } from "@b/shell/api";
import {
  clearCompletedKind,
  type TodosCollectionView,
  todosClearCompletedAsk,
  todosCollectionSlot,
  todosRemove,
  todosToolbarActionsSlot,
} from "@b/todos/api";
import { type Controller, getCommands, getLogger, getSlots, newRegistry, useFields } from "@kernel";
import { createCommitAction, drainCommits, on } from "@kit/commit";
import { attempt } from "@kit/loop";
import { getNotificationTimeout, newNotifier } from "@kit/notify";
import { followFirst } from "@kit/slots";
import { createConfirmModel } from "./confirm.model.js";

const fields = useFields({
  slots: getSlots,
  commands: getCommands,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
});

const plural = (n: number) => `${n} completed todo${n === 1 ? "" : "s"}`;

/**
 * `todos.clear-completed`, mechanism C: the action's record carries the ids that are done AT
 * SUBMIT; its handler asks about exactly those and settles when the question is answered — so the
 * action is `running` (and refuses) for as long as the dialog is open, with no controller write.
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog, timeoutMs } = fields(context);
  const log = rootLog.child({ bundle: "todos.clear-completed" });
  const [register, cleanup] = newRegistry();
  const notifier = newNotifier(slots, timeoutMs);
  register(() => notifier.dispose());
  let active = true;
  let asking: Promise<void> | undefined;
  let closeSession: (() => void) | undefined;
  let collection: TodosCollectionView | undefined;
  const onError = (error: unknown) =>
    log.error("todos.clear-completed: commit failed", { error: String(error) });
  const doneIds = () => (collection?.getTodos() ?? []).filter((t) => t.done).map((t) => t.id);

  const action = createCommitAction({ label: "Clear completed", enabled: false, capture: doneIds });
  register(() => action.dispose());
  register(
    followFirst(
      slots,
      todosCollectionSlot,
      (c) => {
        collection = c;
        return c.onCountsUpdate(() => action.control.update({ enabled: c.getCounts().done > 0 }));
      },
      () => {
        collection = undefined;
        action.control.update({ enabled: false });
      },
    ),
  );

  /** Publishes the question over `ids`; resolves when it is answered or withdrawn. */
  function ask(ids: readonly string[]): Promise<void> {
    if (asking || !active || ids.length === 0) return asking ?? Promise.resolve();
    const model = createConfirmModel(`Delete ${plural(ids.length)}?`, "Clear");
    const [own, release] = newRegistry();
    let answered = () => {};
    asking = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const close = () => {
      closeSession = undefined;
      asking = undefined;
      void release();
      answered();
    };
    own(() => model.dispose());
    own(
      drainCommits(
        { isActive: () => active, onError },
        on(model.control.confirm, async () => {
          const result = await attempt(
            log,
            "clear completed",
            () => commands.call(todosRemove, { ids }).promise,
          );
          if (!active) return;
          close();
          if (result.ok)
            notifier.notify({ message: `Cleared ${plural(result.value)}`, tone: "success" });
          else
            notifier.notify({
              message: `Clear completed failed: ${result.message}`,
              tone: "error",
            });
        }),
        on(model.control.cancel, close),
      ),
    );
    own(
      slots.register(dialogsSlot, "todos:clear-completed", {
        kind: clearCompletedKind,
        title: "Clear completed",
        model: model.view,
      }),
    );
    closeSession = close;
    return asking;
  }

  register(drainCommits({ isActive: () => active, onError }, on(action.control, ask)));
  register(
    commands.listen(todosClearCompletedAsk, async () => {
      void ask(doneIds());
    }),
  );
  register(() => closeSession?.());
  register(
    slots.provide(todosToolbarActionsSlot, {
      id: "todos.clear-completed",
      order: 20,
      action: action.view,
    }),
  );
  register(
    slots.provide(menuSlot, {
      id: "todos.clear-completed",
      group: "todos",
      groupLabel: "Todos",
      order: 20,
      action: action.view,
    }),
  );

  return async () => {
    active = false;
    await cleanup();
  };
};
