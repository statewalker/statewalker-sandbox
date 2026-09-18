import type { Todo, TodoCounts, TodosCollectionView } from "@b/todos/api";
import { readable } from "@kernel";
import { sameRecords, stableGroup } from "@kit/model";
import { signal, untracked } from "@kit/signals";

export interface CollectionControl {
  /** Replaces the whole collection; silent when every todo is field-equal. */
  publishTodos(todos: readonly Todo[]): void;
}

export interface CollectionModel {
  readonly view: TodosCollectionView;
  readonly control: CollectionControl;
  dispose(): void;
}

const EMPTY: readonly Todo[] = Object.freeze([]);

export function createCollectionModel(): CollectionModel {
  let disposed = false;
  const alive = () => !disposed;
  const todos = signal<readonly Todo[]>(EMPTY);
  const counts = stableGroup((): TodoCounts => {
    const all = todos();
    const done = all.filter((t) => t.done).length;
    return Object.freeze({ open: all.length - done, done });
  });
  // P4: the groups are published on the kernel substrate — consumers derive from them directly.
  const view: TodosCollectionView = Object.freeze({
    todos: readable(todos, alive),
    counts: readable(counts, alive),
  });
  const control: CollectionControl = Object.freeze({
    publishTodos: (next: readonly Todo[]) => {
      if (
        disposed ||
        sameRecords(
          untracked(() => todos()),
          next,
        )
      )
        return;
      todos(
        Object.freeze(next.map((t) => Object.freeze({ id: t.id, title: t.title, done: t.done }))),
      );
    },
  });
  return Object.freeze({
    view,
    control,
    dispose: () => {
      if (disposed) return;
      disposed = true;
    },
  });
}
