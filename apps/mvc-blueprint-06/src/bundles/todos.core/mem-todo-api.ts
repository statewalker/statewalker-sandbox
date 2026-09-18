import type { Todo, TodoApi } from "../todos/api/index.js";

export const TODO_SEED: readonly Todo[] = [
  { id: "t1", title: "Buy milk", done: false },
  { id: "t2", title: "Write report", done: false },
  { id: "t3", title: "Call plumber", done: true },
];

/** In-memory todo storage; `delayMs` holds every call in flight so tests can race it. */
export function memTodoApi(seed: readonly Todo[] = TODO_SEED, delayMs = 0): TodoApi {
  let todos = seed.map((t) => ({ ...t }));
  let next = todos.length + 1;
  const later = <T>(f: () => T): Promise<T> =>
    new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(f());
        } catch (e) {
          reject(e);
        }
      }, delayMs),
    );
  return {
    list: () => later(() => todos.map((t) => ({ ...t }))),
    add: (title) =>
      later(() => {
        const todo = { id: `t${next++}`, title, done: false };
        todos = [...todos, todo];
        return { ...todo };
      }),
    update: (id, patch) =>
      later(() => {
        const found = todos.find((t) => t.id === id);
        if (!found) throw new Error(`no todo "${id}"`);
        const updated = { ...found, ...patch };
        todos = todos.map((t) => (t.id === id ? updated : t));
        return { ...updated };
      }),
    remove: (id) =>
      later(() => {
        todos = todos.filter((t) => t.id !== id);
      }),
  };
}
