/**
 * todos.edit — the editor side panel (edit and create mode). Answers `todos/edit-open` and
 * `todos/compose`; contributes Edit to the selection actions and "New todo…" to the main menu.
 */
import {
  type Activator,
  defineMsg,
  disposers,
  getStore,
  next,
  useFields,
} from "../../kernel/index.ts";
import { shellMenu, shellPanels } from "../shell/api/index.ts";
import {
  type TodoReply,
  todoApiFx,
  todoEditorIntents,
  todoEditorKind,
  todosCollection,
  todosCompose,
  todosEditOpen,
  todosSelection,
  todosSelectionActions,
} from "../todos/api/index.ts";

interface Session {
  readonly id: number;
  readonly mode: "edit" | "create";
  readonly todoId?: string;
  readonly title: string;
  readonly saving: boolean;
  readonly error?: string;
}
interface EditState {
  readonly session?: Session;
  readonly seq: number;
}
const editSelected = defineMsg("todos.edit/edit-selected");
const save = defineMsg("todos.edit/save");
const cancel = defineMsg("todos.edit/cancel");
const SAVED = "todos.edit/saved";

const open = (state: EditState, s: Omit<Session, "id" | "saving">): EditState => ({
  seq: state.seq + 1,
  session: { ...s, id: state.seq + 1, saving: false },
});

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);

  const slice = store.addSlice<EditState>({
    id: "todos.edit",
    init: () => ({ seq: 0 }),
    update(state, msg, { select }) {
      const s = state.session;
      if (todosEditOpen.match(msg) || editSelected.match(msg)) {
        const id = todosEditOpen.match(msg) ? msg.id : select(todosSelection)[0]?.ids[0];
        const todo = select(todosCollection)[0]?.todos.find((t) => t.id === id);
        return todo ? open(state, { mode: "edit", todoId: todo.id, title: todo.title }) : state;
      }
      if (todosCompose.match(msg)) return open(state, { mode: "create", title: msg.title });
      if (!s) return state;
      if (todoEditorIntents.title.match(msg)) {
        return { ...state, session: { ...s, title: msg.title, error: undefined } };
      }
      if (cancel.match(msg)) return { ...state, session: undefined };
      if (save.match(msg)) {
        if (s.saving) return state; // refused visibly: Save shows running
        const title = s.title.trim();
        if (!title) return { ...state, session: { ...s, error: "Title is required" } };
        const call =
          s.mode === "create"
            ? ({ op: "add", title } as const)
            : ({ op: "update", id: s.todoId as string, patch: { title } } as const);
        return next({ ...state, session: { ...s, saving: true } }, todoApiFx(call, SAVED, s.id));
      }
      if (msg.type === SAVED) {
        const reply = msg as TodoReply;
        if (reply.ref !== s.id) return state; // a stale session's outcome
        if (reply.ok) return { ...state, session: undefined };
        return { ...state, session: { ...s, saving: false, error: reply.error } };
      }
      return state;
    },
  });

  return disposers(
    slice.contribute(shellPanels, "todos.edit", (state) => {
      const s = state.session;
      if (!s) return [];
      return [
        {
          id: "todos.edit",
          kind: todoEditorKind,
          title: s.mode === "create" ? "New todo" : "Edit todo",
          placement: "side" as const,
          props: {
            mode: s.mode,
            title: s.title,
            error: s.error,
            save: {
              id: "save",
              order: 10,
              label: "Save",
              enabled: !s.saving,
              running: s.saving,
              msg: save(),
            },
            cancel: { id: "cancel", order: 20, label: "Cancel", enabled: true, msg: cancel() },
          },
        },
      ];
    }),
    slice.contribute(todosSelectionActions, "todos.edit", (_state, select) => [
      {
        id: "edit",
        order: 20,
        label: "Edit",
        enabled: select(todosSelection)[0]?.ids.length === 1,
        msg: editSelected(),
      },
    ]),
    slice.contribute(shellMenu, "todos.edit", () => [
      {
        id: "todos.new",
        group: "todos",
        groupLabel: "Todos",
        order: 10,
        label: "New todo…",
        enabled: true,
        msg: todosCompose({ title: "" }),
      },
    ]),
    slice.dispose,
  );
};
