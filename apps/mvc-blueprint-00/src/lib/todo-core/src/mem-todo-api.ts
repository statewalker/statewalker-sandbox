import type { Todo, TodoApi } from "./types.js";

/**
 * In-memory `TodoApi`. Async like every implementation, and deliberately NOT
 * resolving synchronously: `await Promise.resolve()` yields the microtask queue,
 * so a controller that assumes it can read-then-write in one tick fails here
 * rather than in the browser.
 */
export class MemTodoApi implements TodoApi {
  private _rows: Todo[];
  private _seq = 0;
  /** Every call, for tests that assert a controller did not over-fetch. */
  readonly calls: string[] = [];

  constructor(rows: Todo[] = []) {
    this._rows = [...rows];
  }

  private async _tick(name: string): Promise<void> {
    this.calls.push(name);
    await Promise.resolve();
  }

  async list(): Promise<Todo[]> {
    await this._tick("list");
    return [...this._rows];
  }

  async add(title: string): Promise<Todo> {
    await this._tick("add");
    const todo: Todo = { id: `t${++this._seq}`, title, done: false };
    this._rows = [...this._rows, todo];
    return todo;
  }

  async toggle(id: string): Promise<Todo | undefined> {
    await this._tick("toggle");
    let found: Todo | undefined;
    this._rows = this._rows.map((t) => {
      if (t.id !== id) return t;
      found = { ...t, done: !t.done };
      return found;
    });
    return found;
  }

  async remove(id: string): Promise<boolean> {
    await this._tick("remove");
    const next = this._rows.filter((t) => t.id !== id);
    const removed = next.length !== this._rows.length;
    this._rows = next;
    return removed;
  }

  async clearCompleted(): Promise<number> {
    await this._tick("clearCompleted");
    const next = this._rows.filter((t) => !t.done);
    const cleared = this._rows.length - next.length;
    this._rows = next;
    return cleared;
  }
}
