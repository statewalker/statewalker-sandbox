import type { Todo, TodoApi } from "../todos/api/index.js";

const SEED: readonly Todo[] = [
  { id: "t1", title: "Buy milk", done: false },
  { id: "t2", title: "Write report", done: false },
  { id: "t3", title: "Call plumber", done: true },
];

/** In-memory api (§14.1). `delay` holds each call in flight (ms) so tests can race it. */
export function createMemTodoApi(
  options: { delay?: number; seed?: readonly Todo[] } = {},
): TodoApi & {
  calls: Array<{ op: string; args: unknown[] }>;
} {
  let todos = [...(options.seed ?? SEED)];
  let next = todos.length + 1;
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const later = <T>(op: string, args: unknown[], fn: () => T): Promise<T> => {
    calls.push({ op, args });
    return new Promise<T>((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(fn());
        } catch (error) {
          reject(error);
        }
      }, options.delay ?? 0),
    );
  };
  const find = (id: string) => {
    const todo = todos.find((t) => t.id === id);
    if (!todo) throw new Error(`no todo ${id}`);
    return todo;
  };
  return {
    calls,
    list: () => later("list", [], () => todos.map((t) => ({ ...t }))),
    add: (title) =>
      later("add", [title], () => {
        const todo = { id: `t${next++}`, title, done: false };
        todos = [...todos, todo];
        return { ...todo };
      }),
    update: (id, patch) =>
      later("update", [id, patch], () => {
        const todo = { ...find(id), ...patch };
        todos = todos.map((t) => (t.id === id ? todo : t));
        return { ...todo };
      }),
    remove: (id) =>
      later("remove", [id], () => {
        find(id);
        todos = todos.filter((t) => t.id !== id);
      }),
  };
}
