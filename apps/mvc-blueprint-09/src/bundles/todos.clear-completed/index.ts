import { dialogsSlot, menuSlot } from "@b/shell/api";
import {
  clearCompletedKind,
  type TodosCollectionView,
  todosClearCompletedAsk,
  todosCollectionSlot,
  todosRemove,
  todosToolbarActionsSlot,
} from "@b/todos/api";
import {
  type Controller,
  answer,
  call,
  getLogger,
  getSlots,
  newRegistry,
  useFields,
} from "@kernel";
import { attempt, newUpdateLoop } from "@kit/loop";
import { createAction, onSubmits } from "@kit/model";
import { getNotificationTimeout, newNotifier } from "@kit/notify";
import { followFirst } from "@kit/slots";
import { type ConfirmModel, createConfirmModel } from "./confirm.model.js";

const fields = useFields({
  slots: getSlots,
  log: getLogger,
  timeoutMs: getNotificationTimeout,
});

const plural = (n: number) => `${n} completed todo${n === 1 ? "" : "s"}`;

interface Session {
  readonly ids: readonly string[];
  readonly model: ConfirmModel;
  readonly withdraw: () => void;
  answer?: "confirm" | "cancel";
}

/**
 * `todos.clear-completed`: the "Clear completed" action (toolbar + main menu) and the
 * `todos:clear-completed:ask` command. Asking publishes a confirmation over the todos that are
 * done WHEN ASKED; Clear removes exactly those and notifies how many. The action is REFUSED
 * (`running: true`) from the ask until the answer is handled.
 */
export const activate: Controller = async (context) => {
  const { slots, log: rootLog, timeoutMs } = fields(context);
  const log = rootLog.child({ bundle: "todos.clear-completed" });
  const [register, cleanup] = newRegistry();
  const notifier = newNotifier(slots, timeoutMs);
  register(() => notifier.dispose());
  let active = true;
  let session: Session | undefined;
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

  const loop = newUpdateLoop(pass, {
    isActive: () => active,
    onError: (error) => log.error("todos.clear-completed: pass failed", { error: String(error) }),
  });

  function close(s: Session | undefined): void {
    if (!s) return;
    if (session === s) session = undefined;
    s.withdraw();
    if (active) action.control.update({ running: false });
  }

  function ask(): void {
    if (session || !active) return;
    const ids = (collection?.getTodos() ?? []).filter((t) => t.done).map((t) => t.id);
    if (ids.length === 0) return;
    const model = createConfirmModel(`Delete ${plural(ids.length)}?`, "Clear");
    const [own, release] = newRegistry();
    own(() => model.dispose());
    const s: Session = { ids, model, withdraw: () => void release() };
    own(
      onSubmits(model.control.confirm, () => {
        s.answer ??= "confirm";
        loop.kick();
      }),
    );
    own(
      onSubmits(model.control.cancel, () => {
        s.answer ??= "cancel";
        loop.kick();
      }),
    );
    own(
      slots.register(dialogsSlot, "todos:clear-completed", {
        kind: clearCompletedKind,
        title: "Clear completed",
        model: model.view,
      }),
    );
    session = s;
    action.control.update({ running: true });
  }

  let askOwed = false;
  async function pass(): Promise<void> {
    if (askOwed) {
      askOwed = false;
      ask();
    }
    const s = session;
    if (!s?.answer) return;
    if (s.answer === "cancel") return close(s);
    s.model.control.confirm.update({ running: true });
    const result = await attempt(
      log,
      "clear completed",
      () => call(slots, todosRemove, { ids: s.ids }).promise,
    );
    if (!active) return;
    close(s);
    if (result.ok) notifier.notify({ message: `Cleared ${plural(result.value)}`, tone: "success" });
    else notifier.notify({ message: `Clear completed failed: ${result.message}`, tone: "error" });
  }

  // The listener only records the intent: writing `running` here would write the action inside
  // its own notification (MODELS.md §4 point 5).
  register(
    onSubmits(action.control, () => {
      askOwed = true;
      loop.kick();
    }),
  );
  register(
    answer(slots, todosClearCompletedAsk, async () => {
      ask();
    }),
  );
  register(() => close(session));
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
