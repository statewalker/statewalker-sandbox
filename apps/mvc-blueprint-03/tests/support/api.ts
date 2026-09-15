import { MemTodoApi, type Todo, type TodoPatch } from "@todos/core";

type Method = "list" | "add" | "update" | "remove";

/** A `MemTodoApi` whose methods can be made to reject, for failure paths. */
export class ScriptedTodoApi extends MemTodoApi {
  private readonly _failures = new Map<Method, string>();

  fail(method: Method, message: string): void {
    this._failures.set(method, message);
  }

  heal(method: Method): void {
    this._failures.delete(method);
  }

  private _check(method: Method): void {
    const message = this._failures.get(method);
    if (message !== undefined) throw new Error(message);
  }

  override async list(): Promise<Todo[]> {
    this._check("list");
    return super.list();
  }

  override async add(title: string): Promise<Todo> {
    this._check("add");
    return super.add(title);
  }

  override async update(id: string, patch: TodoPatch): Promise<Todo> {
    this._check("update");
    return super.update(id, patch);
  }

  override async remove(id: string): Promise<boolean> {
    this._check("remove");
    return super.remove(id);
  }
}
