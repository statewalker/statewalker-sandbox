import type { Todo, TodoListView, TodosSelectionView } from "@b/todos/api";
import type {
  ActionContribution,
  ActionControl,
  ActionState,
  ActionView,
  Listener,
  Unsubscribe,
} from "@kernel";
import {
  type ActionModel,
  createAction,
  newChannels,
  sameRecords,
  shallowEqual,
  stableGroup,
} from "@kit/model";
import { type Read, signal, untracked } from "@kit/signals";

export interface ListActions<A> {
  readonly add: A;
  readonly toggle: A;
  readonly edit: A;
  readonly remove: A;
}

/** What each commit carries (mechanism B): the form's own state, frozen at submit. */
export interface ListCommits {
  readonly add: string;
  readonly toggle: readonly Pick<Todo, "id" | "done">[];
  readonly edit: readonly string[];
  readonly remove: readonly string[];
}
export interface Commit<T> {
  readonly seq: number;
  readonly value: T;
}
/** One action's commits: written by the view (submit), settled by the controller. */
export interface FormCommits<T> {
  /** Unsettled commits, oldest first. */
  get(): readonly Commit<T>[];
  on(listener: Listener): Unsubscribe;
  settle(seq: number): void;
}

export interface ListControl {
  /** Presentation writers. */
  publishItems(todos: readonly Todo[]): void;
  publishToolbar(items: readonly ActionContribution[]): void;
  publishSelectionActions(items: readonly ActionContribution[]): void;
  reportOutcome(outcome: string | undefined): void;
  /** Resets the new-title form as a whole (after its Add landed). */
  resetNewTitle(): void;
  /** Describes the actions; their `running` is the form's (a commit is unsettled). */
  readonly actions: ListActions<ActionControl>;
  readonly commits: { readonly [K in keyof ListCommits]: FormCommits<ListCommits[K]> };
}

export interface ListModel {
  readonly view: TodoListView & { readonly actions: ListActions<ActionView> };
  /** The selection facet published to `todos:selection`. */
  readonly selection: TodosSelectionView;
  readonly control: ListControl;
  dispose(): void;
}

const EMPTY: readonly never[] = Object.freeze([]);

export function createListModel(): ListModel {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const alive = signal(true);
  const items = signal<readonly Todo[]>(EMPTY);
  const rawSelection = signal<readonly string[]>(EMPTY);
  const newTitle = signal("");
  const toolbar = signal<readonly ActionContribution[]>(EMPTY);
  const selectionActions = signal<readonly ActionContribution[]>(EMPTY);
  const outcome = signal<string | undefined>(undefined);

  // Derived: ids no longer in the collection drop out — the controller never writes the selection.
  const selection = stableGroup((): readonly string[] => {
    const all = items();
    const raw = rawSelection();
    const ids = new Set(all.map((t) => t.id));
    return Object.freeze(raw.filter((id) => ids.has(id)));
  });

  const owned: ActionModel[] = [];
  const action = (label: string, guard: () => boolean, queue = false): ActionModel => {
    const model = createAction({
      label,
      queue,
      when: () => {
        const live = alive();
        const ok = guard();
        return live && ok;
      },
    });
    owned.push(model);
    return model;
  };
  const actions: ListActions<ActionModel> = {
    add: action("Add", () => newTitle().trim() !== "", true),
    toggle: action("Toggle", () => selection().length > 0),
    edit: action("Edit", () => selection().length === 1),
    remove: action("Delete", () => selection().length > 0),
  };

  // The form's commit(): each submit freezes the form state it acts on. Queue for Add.
  const committing = <T>(inner: ActionModel, capture: () => T, queue = false) => {
    const log = signal<readonly Commit<T>[]>(EMPTY);
    const settled = signal(0);
    let seq = 0;
    const pending: Read<readonly Commit<T>[]> = stableGroup(() => {
      const all = log();
      const through = settled();
      return Object.freeze(all.filter((c) => c.seq > through));
    });
    const state = stableGroup((): ActionState => {
      const s = inner.view.getState();
      const busy = pending().length > 0;
      return busy ? Object.freeze({ ...s, running: true }) : s;
    });
    const view: ActionView = Object.freeze({
      getState: () => state(),
      onStateUpdate: channels.channel(state),
      submit: () => {
        const s = untracked(() => state());
        if (disposed || !s.enabled || (s.running && !queue)) return;
        const value = Object.freeze(untracked(capture));
        log(Object.freeze([...untracked(pending), Object.freeze({ seq: ++seq, value })]));
      },
    });
    const commits: FormCommits<T> = Object.freeze({
      get: () => pending(),
      on: channels.channel(pending),
      settle: (n: number) => {
        if (!disposed && n > untracked(() => settled())) settled(n);
      },
    });
    return { view, commits };
  };
  const selectedItems = () => {
    const ids = new Set(selection());
    return Object.freeze(
      items()
        .filter((t) => ids.has(t.id))
        .map(({ id, done }) => Object.freeze({ id, done })),
    );
  };
  const add = committing(actions.add, () => newTitle(), true);
  const toggle = committing(actions.toggle, selectedItems);
  const edit = committing(actions.edit, () => selection());
  const remove = committing(actions.remove, () => selection());

  const view = Object.freeze({
    getItems: () => items(),
    onItemsUpdate: channels.channel(items),
    getSelection: () => selection(),
    onSelectionUpdate: channels.channel(selection),
    select: (ids: readonly string[]) => {
      if (disposed) return;
      const next = Object.freeze([...new Set(ids)]);
      if (
        !shallowEqual(
          untracked(() => rawSelection()),
          next,
        )
      )
        rawSelection(next);
    },
    getNewTitle: () => newTitle(),
    onNewTitleUpdate: channels.channel(newTitle),
    setNewTitle: (title: string) => {
      if (!disposed) newTitle(title);
    },
    getToolbar: () => toolbar(),
    onToolbarUpdate: channels.channel(toolbar),
    getSelectionActions: () => selectionActions(),
    onSelectionActionsUpdate: channels.channel(selectionActions),
    getOutcome: () => outcome(),
    onOutcomeUpdate: channels.channel(outcome),
    toggle: toggle.view,
    actions: Object.freeze({
      add: add.view,
      toggle: toggle.view,
      edit: edit.view,
      remove: remove.view,
    }),
  });

  const selectionView: TodosSelectionView = Object.freeze({
    getSelected: () => selection(),
    onSelectedUpdate: channels.channel(selection),
  });

  const same = <T>(read: () => readonly T[], next: readonly T[]) =>
    disposed || sameRecords(untracked(read), next);

  const control: ListControl = Object.freeze({
    publishItems: (next: readonly Todo[]) => {
      if (!same(items, next)) items(Object.freeze([...next]));
    },
    publishToolbar: (next: readonly ActionContribution[]) => {
      if (!same(toolbar, next)) toolbar(Object.freeze([...next]));
    },
    publishSelectionActions: (next: readonly ActionContribution[]) => {
      if (!same(selectionActions, next)) selectionActions(Object.freeze([...next]));
    },
    reportOutcome: (value: string | undefined) => {
      if (!disposed) outcome(value);
    },
    resetNewTitle: () => {
      if (!disposed) newTitle("");
    },
    actions: Object.freeze({
      add: actions.add.control,
      toggle: actions.toggle.control,
      edit: actions.edit.control,
      remove: actions.remove.control,
    }),
    commits: Object.freeze({
      add: add.commits,
      toggle: toggle.commits,
      edit: edit.commits,
      remove: remove.commits,
    }),
  });

  return Object.freeze({
    view,
    selection: selectionView,
    control,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      alive(false);
      for (const a of owned) a.dispose();
      channels.dispose();
    },
  });
}
