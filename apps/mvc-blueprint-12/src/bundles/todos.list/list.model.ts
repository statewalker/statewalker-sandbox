import type { Todo, TodoListView, TodosSelectionView } from "@b/todos/api";
import type { ActionContribution, ActionControl } from "@kernel";
import {
  type ActionModel,
  createAction,
  newChannels,
  sameRecords,
  shallowEqual,
  stableGroup,
} from "@kit/model";
import { readable } from "@kernel";
import { signal, untracked } from "@kit/signals";

export interface ListActions<A> {
  readonly add: A;
  readonly toggle: A;
  readonly edit: A;
  readonly remove: A;
}

export interface ListControl {
  /** Presentation writers. (P4: no `publishItems` — items are derived from the collection.) */
  publishToolbar(items: readonly ActionContribution[]): void;
  publishSelectionActions(items: readonly ActionContribution[]): void;
  reportOutcome(outcome: string | undefined): void;
  /** Resets the new-title form as a whole (after its Add landed). */
  resetNewTitle(): void;
  readonly actions: ListActions<ActionControl>;
}

export interface ListModel {
  readonly view: TodoListView & { readonly actions: ListActions<ActionModel["view"]> };
  /** The selection facet published to `todos:selection`. */
  readonly selection: TodosSelectionView;
  readonly control: ListControl;
  dispose(): void;
}

const EMPTY: readonly never[] = Object.freeze([]);

/**
 * `source` — P4: the collection's todos as a tracked read on the shared substrate (another
 * bundle's state); the list's items are DERIVED from it, not copied into it by a listener.
 */
export function createListModel(source: () => readonly Todo[] = () => EMPTY): ListModel {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const alive = signal(true);
  const items = stableGroup((): readonly Todo[] => source());
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
    selected: readable(selection, () => !disposed),
  });

  const same = <T>(read: () => readonly T[], next: readonly T[]) =>
    disposed || sameRecords(untracked(read), next);

  const control: ListControl = Object.freeze({
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
