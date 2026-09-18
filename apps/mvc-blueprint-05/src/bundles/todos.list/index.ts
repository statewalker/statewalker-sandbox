/**
 * todos.list — the list panel: selection, the new-title input, Add, Toggle, Delete.
 * Its slice holds only what the user controls here; the rows are derived from `todos:collection`.
 */
import {
  type ActionItem,
  type Activator,
  defineMsg,
  disposers,
  getStore,
  next,
  type Select,
  useFields,
} from "../../kernel/index.ts";
import { shellPanels } from "../shell/api/index.ts";
import {
  type TodoReply,
  todoApiFx,
  todosCollection,
  todosListIntents,
  todosListKind,
  todosSelection,
  todosSelectionActions,
  todosToolbarActions,
} from "../todos/api/index.ts";

interface ListState {
  readonly selected: readonly string[];
  readonly newTitle: string;
  readonly adding: boolean;
}
const add = defineMsg("todos.list/add");
const added = "todos.list/added";
const toggleSelected = defineMsg("todos.list/toggle-selected");
const deleteSelected = defineMsg("todos.list/delete-selected");

const liveSelection = (state: ListState, select: Select): string[] => {
  const todos = select(todosCollection)[0]?.todos ?? [];
  return state.selected.filter((id) => todos.some((t) => t.id === id));
};

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);
  const { newTitle, click, toggle } = todosListIntents;

  const slice = store.addSlice<ListState>({
    id: "todos.list",
    init: () => ({ selected: [], newTitle: "", adding: false }),
    update(state, msg, { select }) {
      if (newTitle.match(msg)) return { ...state, newTitle: msg.title };
      if (click.match(msg)) {
        if (!msg.additive) return { ...state, selected: [msg.id] };
        const has = state.selected.includes(msg.id);
        return {
          ...state,
          selected: has
            ? state.selected.filter((id) => id !== msg.id)
            : [...state.selected, msg.id],
        };
      }
      if (add.match(msg)) {
        const title = state.newTitle.trim();
        if (!title || state.adding) return state; // refused visibly: Add shows disabled
        return next({ ...state, adding: true }, todoApiFx({ op: "add", title }, added));
      }
      if (msg.type === added) {
        const reply = msg as TodoReply;
        const committed = reply.call.op === "add" ? reply.call.title : "";
        // Clear the input only if the user has not typed on since the commit.
        const clear = reply.ok && state.newTitle.trim() === committed;
        return { ...state, adding: false, newTitle: clear ? "" : state.newTitle };
      }
      if (toggle.match(msg)) {
        const todo = select(todosCollection)[0]?.todos.find((t) => t.id === msg.id);
        return todo
          ? next(state, todoApiFx({ op: "update", id: todo.id, patch: { done: !todo.done } }))
          : state;
      }
      if (toggleSelected.match(msg)) {
        const todos = select(todosCollection)[0]?.todos ?? [];
        const chosen = todos.filter((t) => state.selected.includes(t.id));
        if (chosen.length === 0) return state;
        const done = !chosen.every((t) => t.done);
        return next(
          state,
          ...chosen.map((t) => todoApiFx({ op: "update", id: t.id, patch: { done } })),
        );
      }
      if (deleteSelected.match(msg)) {
        const ids = liveSelection(state, select);
        if (ids.length === 0) return state;
        return next({ ...state, selected: [] }, todoApiFx({ op: "remove", ids }));
      }
      return state;
    },
  });

  return disposers(
    slice.contribute(todosSelection, "todos.list", (state, select) => [
      { ids: liveSelection(state, select) },
    ]),
    slice.contribute(todosToolbarActions, "todos.list:add", (state): ActionItem[] => [
      {
        id: "add",
        order: 10,
        label: "Add",
        enabled: state.newTitle.trim() !== "" && !state.adding,
        running: state.adding,
        msg: add(),
      },
    ]),
    slice.contribute(todosSelectionActions, "todos.list", (state, select): ActionItem[] => {
      const n = liveSelection(state, select).length;
      return [
        { id: "toggle", order: 10, label: "Toggle", enabled: n > 0, msg: toggleSelected() },
        { id: "delete", order: 90, label: "Delete", enabled: n > 0, msg: deleteSelected() },
      ];
    }),
    slice.contribute(shellPanels, "todos.list", (state, select) => {
      const collection = select(todosCollection)[0];
      if (!collection) return [];
      const selected = liveSelection(state, select);
      const byOrder = (a: ActionItem, b: ActionItem) =>
        a.order - b.order || a.id.localeCompare(b.id);
      return [
        {
          id: "todos.list",
          kind: todosListKind,
          title: "Todos",
          placement: "main" as const,
          order: 10,
          props: {
            rows: collection.todos.map((t) => ({ ...t, selected: selected.includes(t.id) })),
            newTitle: state.newTitle,
            toolbar: [...select(todosToolbarActions)].sort(byOrder),
            selectionActions: [...select(todosSelectionActions)].sort(byOrder),
          },
        },
      ];
    }),
    slice.dispose,
  );
};
