/**
 * todos.rename — Rename… in the selection actions (exactly one selected) opens a dialog; Rename
 * updates the title as it is when the message is processed and withdraws the dialog; an empty
 * title is refused with a form error.
 */
import {
  type Activator,
  defineMsg,
  disposers,
  getStore,
  next,
  useFields,
} from "../../kernel/index.ts";
import { shellDialogs } from "../shell/api/index.ts";
import {
  renameTodoIntents,
  renameTodoKind,
  type TodoReply,
  todoApiFx,
  todosCollection,
  todosSelection,
  todosSelectionActions,
} from "../todos/api/index.ts";

interface RenameState {
  readonly open?: {
    readonly id: number;
    readonly todoId: string;
    readonly title: string;
    readonly error?: string;
  };
  readonly running: boolean;
  readonly seq: number;
}
const ask = defineMsg("todos.rename/ask");
const rename = defineMsg("todos.rename/rename");
const cancel = defineMsg("todos.rename/cancel");
const DONE = "todos.rename/done";

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);
  const slice = store.addSlice<RenameState>({
    id: "todos.rename",
    init: () => ({ running: false, seq: 0 }),
    update(state, msg, { select }) {
      if (ask.match(msg)) {
        const ids = select(todosSelection)[0]?.ids ?? [];
        const todo = select(todosCollection)[0]?.todos.find((t) => t.id === ids[0]);
        if (ids.length !== 1 || !todo) return state;
        return {
          ...state,
          seq: state.seq + 1,
          open: { id: state.seq + 1, todoId: todo.id, title: todo.title },
        };
      }
      const o = state.open;
      if (!o) return state;
      if (renameTodoIntents.title.match(msg))
        return { ...state, open: { ...o, title: msg.title, error: undefined } };
      if (cancel.match(msg)) return { ...state, open: undefined, running: false };
      if (rename.match(msg)) {
        if (state.running) return state;
        const title = o.title.trim();
        if (!title) return { ...state, open: { ...o, error: "Title is required" } };
        return next(
          { ...state, running: true },
          todoApiFx({ op: "update", id: o.todoId, patch: { title } }, DONE, o.id),
        );
      }
      if (msg.type === DONE) {
        const reply = msg as TodoReply;
        if (reply.ref !== o.id) return state;
        return reply.ok
          ? { ...state, open: undefined, running: false }
          : { ...state, running: false, open: { ...o, error: reply.error } };
      }
      return state;
    },
  });
  return disposers(
    slice.contribute(todosSelectionActions, "todos.rename", (_state, select) => [
      {
        id: "rename",
        order: 30,
        label: "Rename…",
        enabled: select(todosSelection)[0]?.ids.length === 1,
        msg: ask(),
      },
    ]),
    slice.contribute(shellDialogs, "todos.rename", (state) =>
      state.open
        ? [
            {
              id: "todos.rename",
              kind: renameTodoKind,
              title: "Rename todo",
              props: {
                title: state.open.title,
                error: state.open.error,
                rename: {
                  id: "rename",
                  order: 10,
                  label: "Rename",
                  enabled: !state.running,
                  running: state.running,
                  msg: rename(),
                },
                cancel: { id: "cancel", order: 20, label: "Cancel", enabled: true, msg: cancel() },
              },
            },
          ]
        : [],
    ),
    slice.dispose,
  );
};
