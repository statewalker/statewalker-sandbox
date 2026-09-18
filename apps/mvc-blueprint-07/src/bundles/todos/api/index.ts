/** The Todos API (§14.3). Declarations only: types, service keys, slots, intents, view kinds. */
import { defineService } from "../../../kernel/context.js";
import { defineIntent } from "../../../kernel/log.js";
import { type ActionEntry, type ActionView, defineViewKind } from "../../../kernel/models.js";
import { defineSlot } from "../../../kernel/slots.js";

export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}
export interface TodoApi {
  list(): Promise<Todo[]>;
  add(title: string): Promise<Todo>;
  update(id: string, patch: { title?: string; done?: boolean }): Promise<Todo>;
  remove(id: string): Promise<void>;
}
/** The storage service; `todos.core` provides an in-memory one unless the host set it first. */
export const [getTodoApi, setTodoApi, hasTodoApi] = defineService<TodoApi>("todos:api");

/** Async title validation run by a save before it mutates (a multi-step commit). Host-settable. */
export type TitleValidator = (title: string) => Promise<string | undefined>;
export const [getTitleValidator, setTitleValidator, hasTitleValidator] =
  defineService<TitleValidator>("todos:title-validator");

// ── Published state (slots). Single owners; consumers read through these contracts. ──────────
export interface TodosCounts {
  readonly open: number;
  readonly done: number;
}
export interface TodosCollectionView {
  getTodos(): readonly Todo[];
  onTodosUpdate(listener: () => void): () => void;
  getCounts(): TodosCounts;
  onCountsUpdate(listener: () => void): () => void;
}
/** Owner: `todos.core`, a projection of the outcomes of the todos:* intents. */
export const collectionSlot = defineSlot<TodosCollectionView>("todos:collection");

export interface TodosSelectionView {
  getSelected(): readonly string[];
  onSelectedUpdate(listener: () => void): () => void;
}
/** Owner: `todos.list`. Lets selection-action contributors derive `enabled` and read the selection. */
export const selectionSlot = defineSlot<TodosSelectionView>("todos:selection");

export const toolbarActionsSlot = defineSlot<ActionEntry>("todos:toolbar-actions");
export const selectionActionsSlot = defineSlot<ActionEntry>("todos:selection-actions");

// ── Intents (replace commands). The bundle that answers an intent declares it. ────────────────
/** answered by todos.core: the added todo */
export const addTodo = defineIntent<{ title: string }, Todo>("todos:add");
/** answered by todos.core: the updated todo */
export const updateTodo = defineIntent<
  { id: string; patch: { title?: string; done?: boolean } },
  Todo
>("todos:update");
/** answered by todos.core: the removed ids */
export const removeTodos = defineIntent<{ ids: readonly string[] }, readonly string[]>(
  "todos:remove",
);
/** answered by todos.edit once the editor panel is published */
export const openEditor = defineIntent<{ id: string }>("todos:edit:open");
/** answered by todos.edit: the editor in create mode, title prefilled */
export const compose = defineIntent<{ title: string }>("todos:compose");
/** answered by todos.clear-completed: the confirm dialog */
export const askClearCompleted = defineIntent<void>("todos:clear-completed:ask");

// ── View kinds and their models ─────────────────────────────────────────────────────────────
export interface TodoItem extends Todo {
  readonly selected: boolean;
}
export interface TodosListView {
  getItems(): readonly TodoItem[];
  onItemsUpdate(listener: () => void): () => void;
  getNewTitle(): string;
  onNewTitleUpdate(listener: () => void): () => void;
  getToolbar(): readonly ActionEntry[];
  onToolbarUpdate(listener: () => void): () => void;
  getSelectionActions(): readonly ActionEntry[];
  onSelectionActionsUpdate(listener: () => void): () => void;
  /** form writes and intents */
  editNewTitle(title: string): void;
  select(id: string, additive: boolean): void;
  toggle(id: string): void;
}
export const todosListKind = defineViewKind<TodosListView>("todos:list");

export interface TodoDraft {
  readonly title: string;
}
export interface TodoEditorStatus {
  readonly mode: "create" | "edit";
  readonly error?: string;
}
export interface TodoEditorView {
  getDraft(): TodoDraft;
  onDraftUpdate(listener: () => void): () => void;
  getStatus(): TodoEditorStatus;
  onStatusUpdate(listener: () => void): () => void;
  editTitle(title: string): void;
  readonly save: ActionView;
  readonly cancel: ActionView;
}
export const todoEditorKind = defineViewKind<TodoEditorView>("todos:editor");

export interface ClearCompletedView {
  getState(): { readonly count: number };
  onStateUpdate(listener: () => void): () => void;
  readonly confirm: ActionView;
  readonly cancel: ActionView;
}
export const clearCompletedKind = defineViewKind<ClearCompletedView>("todos:clear-completed");
