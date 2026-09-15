import type { Todo, TodoApi, TodoPatch } from "./types.js";

/** In-memory `TodoApi`. Yields a microtask on every call, so no caller can read and write in one tick. */
export class MemTodoApi implements TodoApi {
  private _rows: Todo[];
  private _seq: number;
  /** Every call, for tests that assert what a controller asked for. */
  readonly calls: string[] = [];

  constructor(rows: readonly Todo[] = []) {
    this._rows = rows.map((t) => ({ ...t }));
    this._seq = rows.reduce((max, t) => Math.max(max, Number(/^t(\d+)$/.exec(t.id)?.[1] ?? 0)), 0);
  }

  protected async _tick(name: string): Promise<void> {
    this.calls.push(name);
    await Promise.resolve();
  }

  async list(): Promise<Todo[]> {
    await this._tick("list");
    return this._rows.map((t) => ({ ...t }));
  }

  async add(title: string): Promise<Todo> {
    await this._tick("add");
    const todo: Todo = { id: `t${++this._seq}`, title, done: false };
    this._rows = [...this._rows, todo];
    return { ...todo };
  }

  async update(id: string, patch: TodoPatch): Promise<Todo> {
    await this._tick("update");
    const current = this._rows.find((t) => t.id === id);
    if (!current) throw new Error(`todo not found: ${id}`);
    const next: Todo = {
      id,
      title: patch.title ?? current.title,
      done: patch.done ?? current.done,
    };
    this._rows = this._rows.map((t) => (t.id === id ? next : t));
    return { ...next };
  }

  async remove(id: string): Promise<boolean> {
    await this._tick("remove");
    const next = this._rows.filter((t) => t.id !== id);
    const removed = next.length !== this._rows.length;
    this._rows = next;
    return removed;
  }
}
