/**
 * todos.clear-completed — asks, then removes the todos that were done *when asked*, and notifies.
 * The question captures the ids; the confirmation acts on the question, not on the live list.
 */
import {
  type ActionItem,
  type Activator,
  defineMsg,
  dispatchFx,
  disposers,
  getStore,
  next,
  useFields,
} from "../../kernel/index.ts";
import { shellDialogs, shellMenu, shellNotify } from "../shell/api/index.ts";
import {
  clearCompletedKind,
  type TodoReply,
  todoApiFx,
  todosClearCompletedAsk,
  todosCollection,
  todosToolbarActions,
} from "../todos/api/index.ts";

interface ClearState {
  readonly asking?: { readonly ids: readonly string[] };
  readonly running: boolean;
}
const confirm = defineMsg("todos.clear-completed/confirm");
const cancel = defineMsg("todos.clear-completed/cancel");
const DONE = "todos.clear-completed/done";

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);

  const slice = store.addSlice<ClearState>({
    id: "todos.clear-completed",
    init: () => ({ running: false }),
    update(state, msg, { select }) {
      if (todosClearCompletedAsk.match(msg)) {
        if (state.asking) return state;
        const ids = (select(todosCollection)[0]?.todos ?? [])
          .filter((t) => t.done)
          .map((t) => t.id);
        return ids.length ? { ...state, asking: { ids } } : state;
      }
      if (!state.asking) return state;
      if (cancel.match(msg) && !state.running) return { running: false };
      if (confirm.match(msg)) {
        if (state.running) return state;
        return next(
          { ...state, running: true },
          todoApiFx({ op: "remove", ids: state.asking.ids }, DONE),
        );
      }
      if (msg.type === DONE) {
        const reply = msg as TodoReply;
        const n = reply.call.op === "remove" ? reply.call.ids.length : 0;
        return next(
          { running: false },
          dispatchFx(
            reply.ok
              ? shellNotify({
                  message: `Removed ${n} completed ${n === 1 ? "todo" : "todos"}`,
                  tone: "success",
                })
              : shellNotify({ message: `Clear completed failed: ${reply.error}`, tone: "error" }),
          ),
        );
      }
      return state;
    },
  });

  const askAction = (enabled: boolean): ActionItem => ({
    id: "clear-completed",
    order: 50,
    label: "Clear completed",
    enabled,
    msg: todosClearCompletedAsk(),
  });

  return disposers(
    slice.contribute(todosToolbarActions, "todos.clear-completed", (state, select) => [
      askAction(!state.asking && (select(todosCollection)[0]?.counts.done ?? 0) > 0),
    ]),
    slice.contribute(shellMenu, "todos.clear-completed", (state, select) => [
      {
        ...askAction(!state.asking && (select(todosCollection)[0]?.counts.done ?? 0) > 0),
        id: "todos.clear-completed",
        group: "todos",
        groupLabel: "Todos",
        order: 20,
      },
    ]),
    slice.contribute(shellDialogs, "todos.clear-completed", (state) =>
      state.asking
        ? [
            {
              id: "todos.clear-completed",
              kind: clearCompletedKind,
              title: "Clear completed",
              props: {
                count: state.asking.ids.length,
                confirm: {
                  id: "confirm",
                  order: 10,
                  label: "Clear",
                  enabled: !state.running,
                  running: state.running,
                  msg: confirm(),
                },
                cancel: {
                  id: "cancel",
                  order: 20,
                  label: "Cancel",
                  enabled: !state.running,
                  msg: cancel(),
                },
              },
            },
          ]
        : [],
    ),
    slice.dispose,
  );
};
