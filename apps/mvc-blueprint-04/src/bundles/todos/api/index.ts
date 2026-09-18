import {
  type ActionContribution,
  type ActionView,
  Command,
  defineSlot,
  defineViewKind,
  type Listener,
  newAdapter,
  passthrough,
  type Unsubscribe,
} from "@kernel";

/**
 * The Todos API: everything another bundle needs to use or extend Todos. Declarations only.
 */

// ── data and the injected api ───────────────────────────────────────────────────────────────
export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}
export interface TodoPatch {
  readonly title?: string;
  readonly done?: boolean;
}
/** The in-memory (or remote) store. All async. */
export interface TodoApi {
  list(): Promise<Todo[]>;
  add(title: string): Promise<Todo>;
  update(id: string, patch: TodoPatch): Promise<Todo>;
  remove(id: string): Promise<boolean>;
}
/** `todos:api` — provided by `todos.core` unless the host already set one. Read only by `todos.core`. */
export const todoApiAdapter = newAdapter<TodoApi>("todos:api");

// ── shared state ─────────────────────────────────────────────────────────────────────────────
export interface TodoCounts {
  readonly open: number;
  readonly done: number;
}
/** Presentation, owner `todos.core`. */
export interface TodosCollectionView {
  getTodos(): readonly Todo[];
  onTodosUpdate(listener: Listener): Unsubscribe;
  getCounts(): TodoCounts;
  onCountsUpdate(listener: Listener): Unsubscribe;
}
/** One contribution: the collection, published by its owner `todos.core`. */
export const todosCollectionSlot = defineSlot<TodosCollectionView>("todos:collection");

/** Presentation, owner `todos.list`: the ids selected in the list. */
export interface TodosSelectionView {
  getSelected(): readonly string[];
  onSelectedUpdate(listener: Listener): Unsubscribe;
}
/** One contribution: the list's selection, published by `todos.list`. */
export const todosSelectionSlot = defineSlot<TodosSelectionView>("todos:selection");

// ── extension points ─────────────────────────────────────────────────────────────────────────
/** Add, Clear completed, … */
export const todosToolbarActionsSlot = defineSlot<ActionContribution>("todos:toolbar-actions");
/** Toggle, Edit, Delete, … — act on `todos:selection`. */
export const todosSelectionActionsSlot = defineSlot<ActionContribution>("todos:selection-actions");

// ── commands (answered by Todos) ─────────────────────────────────────────────────────────────
/** Opens the editor on a todo; resolves when the editor panel is published. (`todos.edit`) */
export const todosEditOpen = Command.required("todos:edit:open")
  .input(passthrough<{ id: string }>())
  .output(passthrough<void>())
  .build();
/** Publishes the editor in create mode with the title prefilled; Save adds. (`todos.edit`) */
export const todosCompose = Command.required("todos:compose")
  .input(passthrough<{ title: string }>())
  .output(passthrough<void>())
  .build();
/** Publishes the clear-completed confirmation. (`todos.clear-completed`) */
export const todosClearCompletedAsk = Command.required("todos:clear-completed:ask")
  .input(passthrough<void>())
  .output(passthrough<void>())
  .build();
/** Writes, answered by the collection's owner `todos.core`; the collection updates before they resolve. */
export const todosAdd = Command.required("todos:add")
  .input(passthrough<{ title: string }>())
  .output(passthrough<Todo>())
  .build();
export const todosUpdate = Command.required("todos:update")
  .input(passthrough<{ id: string; patch: TodoPatch }>())
  .output(passthrough<Todo>())
  .build();
/** Resolves with the number removed. */
export const todosRemove = Command.required("todos:remove")
  .input(passthrough<{ ids: readonly string[] }>())
  .output(passthrough<number>())
  .build();

// ── view models and kinds ────────────────────────────────────────────────────────────────────
/** The list panel (main). */
export interface TodoListView {
  /** Presentation: the collection's todos. */
  getItems(): readonly Todo[];
  onItemsUpdate(listener: Listener): Unsubscribe;
  /** Input (view-written): the selection; ids no longer in `items` are dropped on read. */
  getSelection(): readonly string[];
  onSelectionUpdate(listener: Listener): Unsubscribe;
  select(ids: readonly string[]): void;
  /** Input: the new-title field. */
  getNewTitle(): string;
  onNewTitleUpdate(listener: Listener): Unsubscribe;
  setNewTitle(title: string): void;
  /** Presentation: contributions to the two action extension points, sorted. */
  getToolbar(): readonly ActionContribution[];
  onToolbarUpdate(listener: Listener): Unsubscribe;
  getSelectionActions(): readonly ActionContribution[];
  onSelectionActionsUpdate(listener: Listener): Unsubscribe;
  /** Presentation: the last failure, until the next success. */
  getOutcome(): string | undefined;
  onOutcomeUpdate(listener: Listener): Unsubscribe;
  /** The row checkbox: `select([id])` then `toggle.submit()` — one gesture, one tick. */
  readonly toggle: ActionView;
}

export interface TitleDraft {
  readonly title: string;
}
export interface FormStatus {
  readonly touched: boolean;
  readonly dirty: boolean;
  readonly errors: Readonly<Record<string, string>>;
}
/** The editor panel (side): one title field, Save and Cancel. */
export interface TitleFormView {
  getDraft(): TitleDraft;
  onDraftUpdate(listener: Listener): Unsubscribe;
  getStatus(): FormStatus;
  onStatusUpdate(listener: Listener): Unsubscribe;
  editField<K extends keyof TitleDraft>(field: K, value: TitleDraft[K]): void;
  readonly save: ActionView;
  readonly cancel: ActionView;
}

/** The clear-completed dialog. */
export interface ConfirmView {
  getQuestion(): { readonly text: string };
  readonly confirm: ActionView;
  readonly cancel: ActionView;
}

export const todoListKind = defineViewKind<TodoListView>("todos:list");
export const todoEditorKind = defineViewKind<TitleFormView>("todos:editor");
export const clearCompletedKind = defineViewKind<ConfirmView>("todos:clear-completed");
