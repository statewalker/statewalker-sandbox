/** Test apis whose calls can be held in flight and released by the test. */
import type { Todo, TodoApi } from "../../src/bundles/todos/api/index.js";

export interface Gate {
  readonly calls: { method: string; args: unknown[] }[];
  hold: boolean;
  release(): void;
}

export function gatedTodoApi(seed: Todo[]): TodoApi & { gate: Gate } {
  let todos = seed.map((t) => ({ ...t }));
  let next = 100;
  const waiting: (() => void)[] = [];
  const gate: Gate = {
    calls: [],
    hold: false,
    release() {
      for (const w of waiting.splice(0)) w();
    },
  };
  const call = <T>(method: string, args: unknown[], f: () => T): Promise<T> => {
    gate.calls.push({ method, args });
    return new Promise((resolve, reject) => {
      const run = () => {
        try {
          resolve(f());
        } catch (e) {
          reject(e);
        }
      };
      if (gate.hold) waiting.push(run);
      else setTimeout(run, 0);
    });
  };
  return {
    gate,
    list: () => call("list", [], () => todos.map((t) => ({ ...t }))),
    add: (title) =>
      call("add", [title], () => {
        const t = { id: `t${next++}`, title, done: false };
        todos = [...todos, t];
        return t;
      }),
    update: (id, patch) =>
      call("update", [id, patch], () => {
        const t = todos.find((x) => x.id === id);
        if (!t) throw new Error(`no todo ${id}`);
        const u = { ...t, ...patch };
        todos = todos.map((x) => (x.id === id ? u : x));
        return u;
      }),
    remove: (id) =>
      call("remove", [id], () => {
        todos = todos.filter((t) => t.id !== id);
      }),
  };
}
