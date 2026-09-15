import { defineViewKind } from "@sys/ui";
import type { Todo } from "@todo/core";

/**
 * The todo feature's model interfaces and view kinds — the ONLY part of
 * `lib/todo/app` a UI module may import (as `@todo/models`). No implementation
 * lives here, and nothing here imports a reactive library.
 */
export type { Todo };

export interface TodoQuery {
  readonly filterDraft: string;
  readonly showDone: boolean;
}

export interface TodoListView {
  getVisible(): readonly Todo[];
  onVisibleUpdate(listener: () => void): () => void;
  getQuery(): TodoQuery;
  onQueryUpdate(listener: () => void): () => void;
  getOutcome(): string | undefined;
  onOutcomeUpdate(listener: () => void): () => void;
  setFilter(draft: string): void;
  setShowDone(show: boolean): void;
  queueSubmit(title: string): void;
  requestToggle(id: string): void;
  requestRemove(id: string): void;
  requestClearCompleted(): void;
  requestSampleTodos(count: number): void;
}

export interface TodoListControl {
  /** Wakes on any undrained intent. */
  onIntentUpdate(listener: () => void): () => void;
  takePending(): { title: string }[];
  takeToggles(): { id: string }[];
  takeRemovals(): { id: string }[];
  /** A state-latest edge: the controller coalesces against a watermark. */
  getClearCompletedCount(): number;
  takeSampleRequests(): number[];
  getTodos(): readonly Todo[];
  replaceTodos(todos: readonly Todo[]): void;
  reportOutcome(outcome: string | undefined): void;
}

export interface TodoListModel {
  readonly view: TodoListView;
  readonly control: TodoListControl;
  dispose(): void;
}

export interface ConfirmDialogView {
  getQuestion(): string;
  /** The user's answer. The first one wins. */
  answer(confirmed: boolean): void;
}

export interface ConfirmDialogControl {
  onAnswerUpdate(listener: () => void): () => void;
  /** The answer, once; undefined before it arrives and after it was taken. */
  takeAnswer(): boolean | undefined;
}

export interface ConfirmDialogModel {
  readonly view: ConfirmDialogView;
  readonly control: ConfirmDialogControl;
  dispose(): void;
}

export const todoListKind = defineViewKind<TodoListView>("todos:list");
export const confirmDialogKind = defineViewKind<ConfirmDialogView>("todos:confirm");
