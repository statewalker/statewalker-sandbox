/** A record, not a model: nothing subscribes to a single todo. */
export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

export interface TodoPatch {
  readonly title?: string;
  readonly done?: boolean;
}

/** The external service. Every method is async; it knows nothing of models, slots or commands. */
export interface TodoApi {
  list(): Promise<Todo[]>;
  add(title: string): Promise<Todo>;
  /** Rejects when the id is unknown. */
  update(id: string, patch: TodoPatch): Promise<Todo>;
  /** Resolves `false` when the id is unknown. */
  remove(id: string): Promise<boolean>;
}
