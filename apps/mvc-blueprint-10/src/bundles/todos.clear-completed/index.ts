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
import { startMachine } from "@kit/machine";
import { createAction, onSubmits } from "@kit/model";
import { getNotificationTimeout, newNotifier } from "@kit/notify";
import { followFirst } from "@kit/slots";
import { createConfirmModel } from "./confirm.model.js";
import { clearCompletedChart } from "./machine.js";

const fields = useFields({
  slots: getSlots,
  commands: getCommands,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
});

const plural = (n: number) => `${n} completed todo${n === 1 ? "" : "s"}`;

/**
 * `todos.clear-completed`: the "Clear completed" action (toolbar + main menu) and the
 * `todos:clear-completed:ask` command. Asking publishes a confirmation over the todos that are
 * done WHEN ASKED; Clear removes exactly those and notifies how many. The lifecycle is the chart
 * in `machine.ts`.
 */
export const activate: Controller = async (context) => {
  const { slots, commands, log: rootLog, timeoutMs } = fields(context);
  const log = rootLog.child({ bundle: "todos.clear-completed" });
  const [register, cleanup] = newRegistry();
  const notifier = newNotifier(slots, timeoutMs);
  register(() => notifier.dispose());
  let collection: TodosCollectionView | undefined;

  const action = createAction({ label: "Clear completed", enabled: false });
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

  const machine = startMachine(
    clearCompletedChart,
    {
      idle: () => action.control.update({ running: false }),
      busy: (scope) => {
        const ids = scope.data as readonly string[];
        action.control.update({ running: true });
        const model = createConfirmModel(`Delete ${plural(ids.length)}?`, "Clear");
        const [own, release] = newRegistry();
        own(() => model.dispose());
        own(
          slots.register(dialogsSlot, "todos:clear-completed", {
            kind: clearCompletedKind,
            title: "Clear completed",
            model: model.view,
          }),
        );
        return {
          exit: () => void release(),
          states: {
            // The answer is listened to only while asking: the first answer is the answer.
            asking: ({ send }) => {
              const offConfirm = onSubmits(model.control.confirm, () => send("confirm"));
              const offCancel = onSubmits(model.control.cancel, () => send("cancel"));
              return () => {
                offConfirm();
                offCancel();
              };
            },
            clearing: ({ task }) => {
              model.control.confirm.update({ running: true });
              task(
                () => commands.call(todosRemove, { ids }).promise,
                (result) => {
                  if (result.ok)
                    notifier.notify({
                      message: `Cleared ${plural(result.value)}`,
                      tone: "success",
                    });
                  else
                    notifier.notify({
                      message: `Clear completed failed: ${result.message}`,
                      tone: "error",
                    });
                  return "done";
                },
              );
            },
          },
        };
      },
    },
    { log, name: "todos.clear-completed" },
  );
  register(() => machine.stop());

  // The question is fixed here, at commit time: the todos done when asked.
  function ask(): void {
    const ids = (collection?.getTodos() ?? []).filter((t) => t.done).map((t) => t.id);
    if (ids.length > 0) machine.send("ask", ids);
  }
  register(onSubmits(action.control, ask));
  register(commands.listen(todosClearCompletedAsk, async () => ask()));
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

  return cleanup;
};
