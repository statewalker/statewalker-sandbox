import { type Controller, useFields } from "../../kernel/context.js";
import { defineIntent, isOutcome, type LogRecord, openLog } from "../../kernel/log.js";
import { getSlots } from "../../kernel/slots.js";
import { cell, derived } from "../../kit/cell.js";
import {
  addTodo,
  collectionSlot,
  getTodoApi,
  hasTodoApi,
  removeTodos,
  setTodoApi,
  type Todo,
  type TodosCollectionView,
  updateTodo,
} from "../todos/api/index.js";
import { createMemTodoApi } from "./mem-api.js";

/** Private: the initial read. Its outcome is the first fact the collection folds. */
const load = defineIntent<void, Todo[]>("todos.core:load");

/** The collection is a fold over the OUTCOMES of the todos intents — facts, in log order. */
export function foldTodos(todos: readonly Todo[], record: LogRecord): readonly Todo[] {
  if (record.kind !== "outcome" || !record.ok) return todos;
  if (isOutcome(record, load)) return record.value ?? [];
  if (isOutcome(record, addTodo) && record.value) return [...todos, record.value];
  if (isOutcome(record, updateTodo) && record.value) {
    const next = record.value;
    return todos.map((t) => (t.id === next.id ? next : t));
  }
  if (isOutcome(record, removeTodos) && record.value) {
    const gone = new Set(record.value);
    return todos.filter((t) => !gone.has(t.id));
  }
  return todos;
}

const fields = useFields({ slots: getSlots });

/** Answers todos:add/update/remove against the api; owns and publishes `todos:collection`. */
export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  if (!hasTodoApi(context)) setTodoApi(context, createMemTodoApi());
  const api = getTodoApi(context);
  const log = openLog(context, "todos.core");

  log.handle(load, () => api.list());
  log.handle(addTodo, ({ payload }) => api.add(payload.title));
  log.handle(updateTodo, ({ payload }) => api.update(payload.id, payload.patch));
  log.handle(removeTodos, async ({ payload }) => {
    for (const id of payload.ids) await api.remove(id);
    return payload.ids;
  });

  const todos = cell<readonly Todo[]>([]);
  log.project((record) => todos.set(foldTodos(todos.get(), record)));
  const counts = derived([todos], () => {
    const done = todos.get().filter((t) => t.done).length;
    return { open: todos.get().length - done, done };
  });
  const view: TodosCollectionView = Object.freeze({
    getTodos: todos.get,
    onTodosUpdate: todos.subscribe,
    getCounts: counts.get,
    onCountsUpdate: counts.subscribe,
  });
  const unpublish = slots.provide(collectionSlot, view);
  log.append(load, undefined);

  return () => {
    unpublish();
    log.close();
    counts.dispose();
    todos.dispose();
  };
};
