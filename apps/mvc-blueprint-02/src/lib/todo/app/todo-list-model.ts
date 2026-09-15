import { type Signal, signal, untracked } from "@signals";
import type { Todo } from "@todo/core";
import type { TodoListControl, TodoListModel, TodoListView } from "./models.js";
import { newChannels, stableGroup } from "./signal-model.js";

/**
 * The todo list as two frozen facets over signals kept in this closure. Read
 * coarse (visible, query, outcome), write by intention; event edges are
 * replaced queues, clear-completed is a counter.
 */
export function createTodoListModel(): TodoListModel {
  const todos = signal<readonly Todo[]>([]);
  const outcome = signal<string | undefined>(undefined);
  const filterDraft = signal("");
  const showDone = signal(true);
  const pending = signal<{ title: string }[]>([]);
  const toggles = signal<{ id: string }[]>([]);
  const removals = signal<{ id: string }[]>([]);
  const clearCount = signal(0);
  const sampleRequests = signal<number[]>([]);

  const ch = newChannels();
  const live = () => !ch.disposed;
  const peek = <T>(s: Signal<T>): T => untracked(() => s());
  const append = <T>(queue: Signal<T[]>, item: T) => {
    if (live()) queue([...peek(queue), item]);
  };
  const drain =
    <T>(queue: Signal<T[]>) =>
    (): T[] => {
      const items = peek(queue);
      if (items.length === 0 || !live()) return [];
      queue([]);
      return items;
    };

  const visible = stableGroup(() => {
    const needle = filterDraft().trim().toLowerCase();
    const include = showDone();
    return todos().filter(
      (t) => (include || !t.done) && (needle === "" || t.title.toLowerCase().includes(needle)),
    );
  });
  const query = stableGroup(() => ({ filterDraft: filterDraft(), showDone: showDone() }));
  const intents = () => {
    pending();
    toggles();
    removals();
    clearCount();
    sampleRequests();
  };

  const view: TodoListView = Object.freeze({
    getVisible: () => visible(),
    onVisibleUpdate: ch.channel(visible),
    getQuery: () => query(),
    onQueryUpdate: ch.channel(query),
    getOutcome: () => outcome(),
    onOutcomeUpdate: ch.channel(() => outcome()),
    setFilter: (draft: string) => {
      if (live()) filterDraft(draft);
    },
    setShowDone: (show: boolean) => {
      if (live()) showDone(show);
    },
    queueSubmit: (title: string) => append(pending, { title }),
    requestToggle: (id: string) => append(toggles, { id }),
    requestRemove: (id: string) => append(removals, { id }),
    requestClearCompleted: () => {
      if (live()) clearCount(peek(clearCount) + 1);
    },
    requestSampleTodos: (count: number) => append(sampleRequests, count),
  });

  const control: TodoListControl = Object.freeze({
    onIntentUpdate: ch.channel(intents),
    takePending: drain(pending),
    takeToggles: drain(toggles),
    takeRemovals: drain(removals),
    getClearCompletedCount: () => peek(clearCount),
    takeSampleRequests: drain(sampleRequests),
    getTodos: () => peek(todos),
    replaceTodos: (list: readonly Todo[]) => {
      if (live()) todos([...list]);
    },
    reportOutcome: (next: string | undefined) => {
      if (live()) outcome(next);
    },
  });

  return Object.freeze({ view, control, dispose: () => ch.dispose() });
}
