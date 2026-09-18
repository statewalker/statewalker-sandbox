import type { Todo, TodoApi } from "../todos/api/index.ts";

export type Delay = number | (() => Promise<void>);
const wait = (delay: Delay | undefined) =>
  typeof delay === "function"
    ? delay()
    : new Promise<void>((resolve) => setTimeout(resolve, delay ?? 0));

export const TODO_SEED: readonly Todo[] = [
  { id: "t1", title: "Buy milk", done: false },
  { id: "t2", title: "Write report", done: false },
  { id: "t3", title: "Call plumber", done: true },
];

/** The in-memory api of §14.1. `delay` holds every call (tests pass a gate). */
export function createMemTodoApi(options: { delay?: Delay; seed?: readonly Todo[] } = {}): TodoApi {
  let todos = [...(options.seed ?? TODO_SEED)];
  let seq = todos.length;
  const find = (id: string) => {
    const todo = todos.find((t) => t.id === id);
    if (!todo) throw new Error(`no todo ${id}`);
    return todo;
  };
  return {
    async list() {
      await wait(options.delay);
      return [...todos];
    },
    async add(title) {
      await wait(options.delay);
      const todo = { id: `t${++seq}`, title, done: false };
      todos = [...todos, todo];
      return todo;
    },
    async update(id, patch) {
      await wait(options.delay);
      const todo = { ...find(id), ...patch };
      todos = todos.map((t) => (t.id === id ? todo : t));
      return todo;
    },
    async remove(id) {
      await wait(options.delay);
      find(id);
      todos = todos.filter((t) => t.id !== id);
    },
  };
}
