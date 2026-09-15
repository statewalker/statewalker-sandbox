import { newRegistry } from "@statewalker/shared-registry";
import { type ActionModel, createAction } from "@sys/action";
import { newChannels, shallowEqual, stableGroup } from "@sys/model-kit";
import { batch, signal, untracked } from "@sys/signals";
import type {
  Todo,
  TodoListActions,
  TodoListControl,
  TodoListModel,
  TodoListView,
  TodoQuery,
} from "./list.model.js";

const EMPTY: readonly never[] = Object.freeze([]);

const sameTodos = (a: readonly Todo[], b: readonly Todo[]): boolean =>
  a.length === b.length &&
  a.every((t, i) => t.id === b[i].id && t.title === b[i].title && t.done === b[i].done);

export function createTodoListModel(): TodoListModel {
  const [register, cleanup] = newRegistry();
  let disposed = false;
  const channels = newChannels(() => disposed);
  register(() => channels.dispose());

  const alive = signal(true);
  const items = signal<readonly Todo[]>(EMPTY);
  const filterDraft = signal("");
  const showDone = signal(true);
  const selection = signal<readonly string[]>(EMPTY);
  const newTitle = signal("");
  const outcome = signal<string | undefined>(undefined);

  const query = stableGroup((): TodoQuery => {
    const draft = filterDraft();
    const done = showDone();
    return Object.freeze({ filterDraft: draft, showDone: done });
  });

  // Reads every input before filtering: a computed depends only on what its last run read.
  const visible = stableGroup((): readonly Todo[] => {
    const all = items();
    const { filterDraft: draft, showDone: done } = query();
    const needle = draft.trim().toLowerCase();
    return Object.freeze(
      all.filter(
        (t) => (done || !t.done) && (needle === "" || t.title.toLowerCase().includes(needle)),
      ),
    );
  });

  const action = (label: string, icon: string, guard: () => boolean): ActionModel => {
    const model = createAction({
      label,
      icon,
      // `alive()` first, so every action disables itself the moment the list is disposed.
      when: () => {
        const live = alive();
        const allowed = guard();
        return live && allowed;
      },
    });
    register(() => model.dispose());
    return model;
  };

  const actions: TodoListActions<ActionModel> = {
    add: action("Add", "plus", () => newTitle().trim() !== ""),
    toggle: action("Toggle", "check", () => selection().length > 0),
    remove: action("Delete", "trash-2", () => selection().length > 0),
    edit: action("Edit", "pencil", () => selection().length === 1),
    clearCompleted: action("Clear completed", "list-x", () => items().some((t) => t.done)),
  };

  const view: TodoListView = Object.freeze({
    getItems: () => items(),
    onItemsUpdate: channels.channel(items),
    getVisible: () => visible(),
    onVisibleUpdate: channels.channel(visible),
    getQuery: () => query(),
    onQueryUpdate: channels.channel(query),
    getSelection: () => selection(),
    onSelectionUpdate: channels.channel(selection),
    getNewTitle: () => newTitle(),
    onNewTitleUpdate: channels.channel(newTitle),
    getOutcome: () => outcome(),
    onOutcomeUpdate: channels.channel(outcome),
    setFilter: (draft: string) => {
      if (!disposed) filterDraft(draft);
    },
    setShowDone: (show: boolean) => {
      if (!disposed) showDone(show);
    },
    select: (ids: readonly string[]) => {
      if (disposed) return;
      const next = Object.freeze([...new Set(ids)]);
      if (
        shallowEqual(
          untracked(() => selection()),
          next,
        )
      )
        return;
      selection(next);
    },
    setNewTitle: (title: string) => {
      if (!disposed) newTitle(title);
    },
    actions: Object.freeze({
      add: actions.add.view,
      toggle: actions.toggle.view,
      remove: actions.remove.view,
      edit: actions.edit.view,
      clearCompleted: actions.clearCompleted.view,
    }),
  });

  const control: TodoListControl = Object.freeze({
    replaceItems: (todos: readonly Todo[]) => {
      if (disposed) return;
      batch(() => {
        const current = untracked(() => items());
        if (!sameTodos(current, todos)) {
          items(
            Object.freeze(
              todos.map((t) => Object.freeze({ id: t.id, title: t.title, done: t.done })),
            ),
          );
        }
        const ids = new Set(todos.map((t) => t.id));
        const selected = untracked(() => selection());
        const kept = selected.filter((id) => ids.has(id));
        if (kept.length !== selected.length) selection(Object.freeze(kept));
      });
    },
    reportOutcome: (value: string | undefined) => {
      if (!disposed) outcome(value);
    },
    clearNewTitle: () => {
      if (!disposed) newTitle("");
    },
    actions: Object.freeze({
      add: actions.add.control,
      toggle: actions.toggle.control,
      remove: actions.remove.control,
      edit: actions.edit.control,
      clearCompleted: actions.clearCompleted.control,
    }),
  });

  return Object.freeze({
    view,
    control,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      alive(false);
      void cleanup();
    },
  });
}
