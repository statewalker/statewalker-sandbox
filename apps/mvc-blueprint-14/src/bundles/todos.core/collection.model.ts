import type { Todo, TodoCounts, TodosCollectionView } from "@b/todos/api";
import { newChannels, sameRecords, stableGroup } from "@kit/model";
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
  const channels = newChannels(() => disposed);
  const todos = signal<readonly Todo[]>(EMPTY);
  const counts = stableGroup((): TodoCounts => {
    const all = todos();
    const done = all.filter((t) => t.done).length;
    return Object.freeze({ open: all.length - done, done });
  });
  const view: TodosCollectionView = Object.freeze({
    getTodos: () => todos(),
    onTodosUpdate: channels.channel(todos),
    getCounts: () => counts(),
    onCountsUpdate: channels.channel(counts),
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
      channels.dispose();
    },
  });
}
