/**
 * Todos API — declarations only: types, the api service key, points, public messages, effects,
 * view kinds. What P0 exposes as a slot of models and commands, R1 exposes as points (derived
 * data) and messages (fire-and-forget; outcomes come back as reply messages).
 */
import {
  type ActionItem,
  defineMsg,
  definePoint,
  defineViewKind,
  type Effect,
  type Msg,
} from "../../../kernel/index.ts";

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
/** Service key: set by the host to inject an api (with a delay); todos.core provides a default. */
export const TODO_API_KEY = "todos:api";

// ---- points (published, derived views) -----------------------------------------------------------
export interface TodosCollection {
  readonly todos: readonly Todo[];
  readonly counts: { readonly open: number; readonly done: number };
}
/** One contribution, owner `todos.core`. */
export const todosCollection = definePoint<TodosCollection>("todos:collection");
/** One contribution, owner `todos.list`: the selected ids that still exist. */
export const todosSelection = definePoint<{ readonly ids: readonly string[] }>("todos:selection");
export const todosToolbarActions = definePoint<ActionItem>("todos:toolbar-actions");
export const todosSelectionActions = definePoint<ActionItem>("todos:selection-actions");

// ---- public messages ---------------------------------------------------------------------------
/** Opens the editor for a todo (answered by `todos.edit`). */
export const todosEditOpen = defineMsg<{ id: string }>("todos/edit-open");
/** Opens the editor in create mode with the title prefilled (answered by `todos.edit`). */
export const todosCompose = defineMsg<{ title: string }>("todos/compose");
/** Asks to clear completed todos (answered by `todos.clear-completed`). */
export const todosClearCompletedAsk = defineMsg("todos/clear-completed-ask");

// ---- the api effect (performed by `todos.core`) ------------------------------------------------
export type TodoCall =
  | { readonly op: "add"; readonly title: string }
  | {
      readonly op: "update";
      readonly id: string;
      readonly patch: { title?: string; done?: boolean };
    }
  | { readonly op: "remove"; readonly ids: readonly string[] };
export interface TodoApiEffect extends Effect {
  readonly type: "todos/api";
  readonly call: TodoCall;
  /** When set, the handler dispatches `{ type: reply, ref, ok, error? }` after the collection updates. */
  readonly reply?: string;
  readonly ref?: number;
}
export const todoApiFx = (call: TodoCall, reply?: string, ref?: number): TodoApiEffect => ({
  type: "todos/api",
  call,
  reply,
  ref,
});
export interface TodoReply extends Msg {
  readonly ref?: number;
  readonly ok: boolean;
  readonly error?: string;
  /** What was committed, echoed back: the call as the handler performed it. */
  readonly call: TodoCall;
}

// ---- view kinds -------------------------------------------------------------------------------
export interface TodoRow {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly selected: boolean;
}
export interface TodosListProps {
  readonly rows: readonly TodoRow[];
  readonly newTitle: string;
  readonly toolbar: readonly ActionItem[];
  readonly selectionActions: readonly ActionItem[];
}
export interface TodoEditorProps {
  readonly mode: "edit" | "create";
  readonly title: string;
  readonly error?: string;
  readonly save: ActionItem;
  readonly cancel: ActionItem;
}
export interface ClearCompletedProps {
  readonly count: number;
  readonly confirm: ActionItem;
  readonly cancel: ActionItem;
}
export interface RenameTodoProps {
  readonly title: string;
  readonly error?: string;
  readonly rename: ActionItem;
  readonly cancel: ActionItem;
}
export const renameTodoKind = defineViewKind<RenameTodoProps>("todos:rename");
export const todosListKind = defineViewKind<TodosListProps>("todos:list");
export const todoEditorKind = defineViewKind<TodoEditorProps>("todos:editor");
export const clearCompletedKind = defineViewKind<ClearCompletedProps>("todos:clear-completed");

// ---- view intents: the messages a renderer of these kinds dispatches (besides ActionItem.msg) ----
export const todosListIntents = {
  newTitle: defineMsg<{ title: string }>("todos.list/new-title"),
  click: defineMsg<{ id: string; additive: boolean }>("todos.list/click"),
  toggle: defineMsg<{ id: string }>("todos.list/toggle"),
};
export const todoEditorIntents = {
  title: defineMsg<{ title: string }>("todos.edit/title"),
};
export const renameTodoIntents = {
  title: defineMsg<{ title: string }>("todos.rename/title"),
};
