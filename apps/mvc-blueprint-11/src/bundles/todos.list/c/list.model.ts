import type { Todo, TodoListView, TodosSelectionView } from "@b/todos/api";
import type { ActionContribution, ActionView } from "@kernel";
import { type CommitActionModel, type CommitControl, createCommitAction } from "@kit/commit";
import { newChannels, sameRecords, shallowEqual, stableGroup } from "@kit/model";
import { signal, untracked } from "@kit/signals";

export interface ListActions<A> {
  readonly add: A;
  readonly toggle: A;
  readonly edit: A;
  readonly remove: A;
}

/** What each action's record carries (mechanism C), captured at submit. */
export interface ListCommits {
  readonly add: string;
  readonly toggle: readonly Pick<Todo, "id" | "done">[];
  readonly edit: readonly string[];
  readonly remove: readonly string[];
}
type Controls = { readonly [K in keyof ListCommits]: CommitControl<ListCommits[K]> };

export interface ListControl {
  /** Presentation writers. */
  publishItems(todos: readonly Todo[]): void;
  publishToolbar(items: readonly ActionContribution[]): void;
  publishSelectionActions(items: readonly ActionContribution[]): void;
  reportOutcome(outcome: string | undefined): void;
  /** Resets the new-title form as a whole (after its Add landed). */
  resetNewTitle(): void;
  readonly actions: Controls;
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

  const owned: CommitActionModel<unknown>[] = [];
  const action = <T>(
    label: string,
    guard: () => boolean,
    capture: () => T,
    queue = false,
  ): CommitActionModel<T> => {
    const model = createCommitAction({
      label,
      queue,
      capture,
      when: () => {
        const live = alive();
        const ok = guard();
        return live && ok;
      },
    });
    owned.push(model as CommitActionModel<unknown>);
    return model;
  };
  const selectedItems = () => {
    const ids = new Set(selection());
    return items()
      .filter((t) => ids.has(t.id))
      .map(({ id, done }) => ({ id, done }));
  };
  const actions = {
    add: action(
      "Add",
      () => newTitle().trim() !== "",
      () => newTitle(),
      true,
    ),
    toggle: action("Toggle", () => selection().length > 0, selectedItems),
    edit: action(
      "Edit",
      () => selection().length === 1,
      () => selection(),
    ),
    remove: action(
      "Delete",
      () => selection().length > 0,
      () => selection(),
    ),
  };

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
    toggle: actions.toggle.view,
    actions: Object.freeze({
      add: actions.add.view,
      toggle: actions.toggle.view,
      edit: actions.edit.view,
      remove: actions.remove.view,
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
