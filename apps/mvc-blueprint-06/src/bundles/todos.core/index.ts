/**
 * `todos.core` — the service actor. It owns the storage api (private) and is the single writer of
 * `todos:collection`; everyone else changes todos by asking it.
 */
import type { Behavior, BundleManifest } from "../../kernel/index.js";
import {
  collection,
  type Todo,
  type TodoApi,
  type TodosCollection,
  type TodosCoreMsg,
  todosCore,
} from "../todos/api/index.js";
import { memTodoApi } from "./mem-todo-api.js";

const toCollection = (todos: readonly Todo[]): TodosCollection => {
  const done = todos.filter((t) => t.done).length;
  return { todos, counts: { open: todos.length - done, done } };
};

export function todosCoreBundle(options: { api?: TodoApi } = {}): BundleManifest {
  const behavior: Behavior<TodosCoreMsg> = (ctx) => {
    const api = options.api ?? memTodoApi();
    let todos: readonly Todo[] = [];
    const set = (next: readonly Todo[]) => {
      todos = next;
      ctx.publish(collection, toCollection(todos));
    };
    ctx.pipe(api.list(), set, (e) => ctx.log.error("loading todos failed", e));

    return (msg, env) => {
      switch (msg.type) {
        case "todos:add":
          ctx.pipe(
            api.add(msg.title),
            (todo) => {
              set([...todos, todo]);
              env.ok(todo);
            },
            env.fail,
          );
          return;
        case "todos:update":
          ctx.pipe(
            api.update(msg.id, msg.patch),
            (todo) => {
              set(todos.map((t) => (t.id === todo.id ? todo : t)));
              env.ok(todo);
            },
            env.fail,
          );
          return;
        case "todos:remove": {
          const ids = [...msg.ids];
          ctx.pipe(
            Promise.all(ids.map((id) => api.remove(id))),
            () => {
              set(todos.filter((t) => !ids.includes(t.id)));
              env.ok(ids.length);
            },
            env.fail,
          );
          return;
        }
      }
    };
  };
  return { id: todosCore, behavior };
}
