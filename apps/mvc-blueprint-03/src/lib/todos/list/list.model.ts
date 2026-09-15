import type { ActionControl, ActionView } from "@sys/action/model";
import { defineViewKind } from "@sys/extension-points";
import type { Todo } from "@todos/core";

export type { Todo };

export interface TodoQuery {
  readonly filterDraft: string;
  readonly showDone: boolean;
}

export interface TodoListActions<A> {
  readonly add: A;
  readonly toggle: A;
  readonly remove: A;
  readonly edit: A;
  readonly clearCompleted: A;
}

/**
 * The list's view facet. Data and data intents: what the user sees, filters,
 * selects and types. Intents to DO something are the actions — they carry no
 * payload; the selection and the new title are what they act on.
 */
export interface TodoListView {
  getItems(): readonly Todo[];
  onItemsUpdate(listener: () => void): () => void;
  getVisible(): readonly Todo[];
  onVisibleUpdate(listener: () => void): () => void;
  getQuery(): TodoQuery;
  onQueryUpdate(listener: () => void): () => void;
  getSelection(): readonly string[];
  onSelectionUpdate(listener: () => void): () => void;
  getNewTitle(): string;
  onNewTitleUpdate(listener: () => void): () => void;
  getOutcome(): string | undefined;
  onOutcomeUpdate(listener: () => void): () => void;
  setFilter(draft: string): void;
  setShowDone(show: boolean): void;
  /** Replaces the selection. Duplicates are dropped. */
  select(ids: readonly string[]): void;
  setNewTitle(title: string): void;
  readonly actions: TodoListActions<ActionView>;
}

/** The controller's facet: results in, and the actions' control side. */
export interface TodoListControl {
  /** Also drops selected ids that no longer exist. Silent when every todo is field-equal. */
  replaceItems(todos: readonly Todo[]): void;
  reportOutcome(outcome: string | undefined): void;
  clearNewTitle(): void;
  readonly actions: TodoListActions<ActionControl>;
}

export interface TodoListModel {
  readonly view: TodoListView;
  readonly control: TodoListControl;
  dispose(): void;
}

export const todoListKind = defineViewKind<TodoListView>("todos:list");
