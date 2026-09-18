/**
 * Todos API — declarations only: addresses and their messages, streams, extension points, view
 * kinds with their state and message types.
 */
import {
  type ActionDesc,
  type ActionItem,
  type Asks,
  defineAddress,
  definePoint,
  defineStream,
  defineViewKind,
} from "../../../kernel/index.js";

export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

/** The storage service interface; `todos.core` wraps one. Injected through the manifest. */
export interface TodoApi {
  list(): Promise<Todo[]>;
  add(title: string): Promise<Todo>;
  update(id: string, patch: { title?: string; done?: boolean }): Promise<Todo>;
  remove(id: string): Promise<void>;
}

// --- todos.core: owns the api and the collection ---------------------------------------------
export type TodosCoreMsg =
  | ({ type: "todos:add"; title: string } & Asks<Todo>)
  | ({ type: "todos:update"; id: string; patch: { title?: string; done?: boolean } } & Asks<Todo>)
  | ({ type: "todos:remove"; ids: readonly string[] } & Asks<number>);
export const todosCore = defineAddress<TodosCoreMsg>("todos.core");

export interface TodosCollection {
  readonly todos: readonly Todo[];
  readonly counts: { readonly open: number; readonly done: number };
}
/** Presentation state, owner `todos.core`. Absent (undefined) while no owner runs. */
export const collection = defineStream<TodosCollection>("todos:collection");

// --- todos.list: owns the selection and the list's action points -------------------------------
/** The selected todo ids, owner `todos.list`. */
export const selection = defineStream<readonly string[]>("todos:selection");
export const toolbarActions = definePoint<ActionItem>("todos:toolbar-actions", "todos.list");
export const selectionActions = definePoint<ActionItem>("todos:selection-actions", "todos.list");

export type ListMsg =
  | { type: "select"; id: string; additive: boolean }
  | { type: "toggle-one"; id: string }
  | { type: "new-title"; value: string }
  | { type: "add" }
  | { type: "toggle-selected" }
  | { type: "delete-selected" };
export interface ListState {
  readonly todos: readonly Todo[];
  readonly selected: readonly string[];
  readonly newTitle: string;
  readonly toolbar: readonly ActionItem[];
  readonly selectionActions: readonly ActionItem[];
}
export const listKind = defineViewKind<ListState, ListMsg>("todos:list");

// --- todos.edit: answers todos:edit:open and todos:compose ------------------------------------
export type EditorMsg = { type: "edit"; title: string } | { type: "save" } | { type: "cancel" };
export type TodosEditMsg =
  | ({ type: "todos:edit:open"; id: string } & Asks<void>)
  | ({ type: "todos:compose"; title: string } & Asks<void>)
  | EditorMsg;
export const todosEdit = defineAddress<TodosEditMsg>("todos.edit");
export interface EditorState {
  readonly mode: "edit" | "create";
  readonly title: string;
  readonly error?: string;
  readonly save: ActionDesc;
  readonly cancel: ActionDesc;
}
export const editorKind = defineViewKind<EditorState, EditorMsg>("todos:editor");

// --- todos.clear-completed: answers todos:clear-completed:ask ----------------------------------
export type ClearCompletedMsg =
  | ({ type: "todos:clear-completed:ask" } & Asks<void>)
  | { type: "confirm" }
  | { type: "cancel" };
export const todosClearCompleted = defineAddress<ClearCompletedMsg>("todos.clear-completed");
export interface ClearCompletedState {
  readonly count: number;
  readonly confirm: ActionDesc;
  readonly cancel: ActionDesc;
}
export const clearCompletedKind = defineViewKind<ClearCompletedState, ClearCompletedMsg>(
  "todos:clear-completed",
);
