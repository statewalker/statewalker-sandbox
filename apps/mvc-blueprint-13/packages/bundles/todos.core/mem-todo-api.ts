import type { Todo, TodoApi, TodoPatch } from "@p5/todos/api";

export const seedTodos: readonly Todo[] = Object.freeze([
  { id: "t1", title: "Buy milk", done: false },
  { id: "t2", title: "Write report", done: false },
  { id: "t3", title: "Call plumber", done: true },
]);

/** In-memory `TodoApi` with an injected delay (tests hold a commit in flight) and scripted failures. */
export class MemTodoApi implements TodoApi {
  private _rows: Todo[];
  private _seq: number;
  private readonly _failures = new Map<string, string>();
  /** Every call, for tests. */
  readonly calls: { method: string; args: unknown[] }[] = [];

  constructor(
    rows: readonly Todo[] = seedTodos,
    private readonly _delayMs = 0,
  ) {
    this._rows = rows.map((t) => ({ ...t }));
    this._seq = rows.length;
  }

  /** The next call to `method` rejects with `message`. */
  fail(method: keyof TodoApi, message: string): void {
    this._failures.set(method, message);
  }

  private async _enter(method: string, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    if (this._delayMs > 0) await new Promise((r) => setTimeout(r, this._delayMs));
    else await Promise.resolve();
    const failure = this._failures.get(method);
    if (failure !== undefined) {
      this._failures.delete(method);
      throw new Error(failure);
    }
  }

  async list(): Promise<Todo[]> {
    await this._enter("list", []);
    return this._rows.map((t) => ({ ...t }));
  }

  async add(title: string): Promise<Todo> {
    await this._enter("add", [title]);
    const todo: Todo = { id: `t${++this._seq}`, title, done: false };
    this._rows = [...this._rows, todo];
    return { ...todo };
  }

  async update(id: string, patch: TodoPatch): Promise<Todo> {
    await this._enter("update", [id, patch]);
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
    await this._enter("remove", [id]);
    const next = this._rows.filter((t) => t.id !== id);
    const removed = next.length !== this._rows.length;
    this._rows = next;
    return removed;
  }
}
