import type { Todo } from "@todo/core";
import { computed, type Read, type Signal, signal, untracked } from "@todo/signals";

/**
 * Re-exported for convenience, NOT re-declared: two `export *` barrels
 * exporting one name would make TypeScript export neither.
 */
export type { Todo };

/** What a view is handed — the reads it renders and the intents it raises. Nothing that writes a result. */
export interface TodoListView {
  /** Derived from `todos`, `filterDraft` and `showDone`; the same reference until one of them changes. */
  readonly visible: Read<Todo[]>;
  readonly filterDraft: Read<string>;
  readonly showDone: Read<boolean>;
  readonly lastOutcome: Read<string | undefined>;
  setFilter(draft: string): void;
  setShowDone(show: boolean): void;
  requestRefresh(): void;
  requestClearCompleted(): void;
  queueSubmit(title: string): void;
  requestToggle(id: string): void;
  requestRemove(id: string): void;
}

/** The input a controller reacts to — read-only; drained through `TodoListControl`. */
export interface TodoListEdges {
  /** State-latest edge — N bumps in one tick are ONE reload. */
  readonly refreshCount: Read<number>;
  /** State-latest edge — two quick presses are ONE confirm dialog. */
  readonly clearCompletedCount: Read<number>;
  /** Event edge — N submissions are N todos; the title rides with the edge. */
  readonly pending: Read<{ title: string }[]>;
  /** Event edge — every toggle is honoured; the row id rides with it. */
  readonly toggles: Read<{ id: string }[]>;
  /** Event edge — every delete is honoured. */
  readonly removals: Read<{ id: string }[]>;
}

/** What the controller is handed — the edges, the drains, and the result writers. */
export interface TodoListControl {
  readonly edges: TodoListEdges;
  readonly todos: Read<Todo[]>;
  takePending(): { title: string }[];
  takeToggles(): { id: string }[];
  takeRemovals(): { id: string }[];
  replaceTodos(todos: Todo[]): void;
  reportOutcome(outcome: string | undefined): void;
}

export interface TodoListModel {
  readonly view: TodoListView;
  readonly control: TodoListControl;
}

/**
 * The todo list, as two facets over one set of signals.
 *
 * The signals live in this closure: nothing outside it can hold a writable one,
 * so "a model is changed only through its mutators" (parent D5) is a fact of
 * scope, not a grep. The view is handed `view` and nothing else, so it cannot
 * reach `replaceTodos` or a drain (parent D20). `visible` is a `computed`, so
 * it is tracked through the query fields and the list with no forwarding
 * (parent D16).
 *
 * Kept as rules, because the substrate cannot make them facts:
 * - arrays are REPLACED, never mutated — change detection is by identity;
 * - an event edge is a replaced queue that carries its payload;
 * - a mutator reads its own signals `untracked`, so calling it from inside any
 *   reaction adds no dependency;
 * - a mutator that writes two signals does so inside `batch` (none does yet).
 * Free under the contract: a write equal to the held value notifies nobody.
 */
export function createTodoListModel(): TodoListModel {
  // Results — written by the controller only.
  const todos = signal<Todo[]>([]);
  /** Outcomes go here, not on the input, so a declined intent never wipes live typing. */
  const lastOutcome = signal<string | undefined>(undefined);
  // Input, level — the controller reconciles to the latest value.
  const filterDraft = signal("");
  const showDone = signal(true);
  // Input, state-latest edges — counters the controller coalesces against a watermark.
  const refreshCount = signal(0);
  const clearCompletedCount = signal(0);
  // Input, event edges — replaced queues; every item is honoured.
  const pending = signal<{ title: string }[]>([]);
  const toggles = signal<{ id: string }[]>([]);
  const removals = signal<{ id: string }[]>([]);

  /** A reader without the setter — a new function, so the signal's write half is never handed out. */
  const reader =
    <T>(s: Signal<T>): Read<T> =>
    () =>
      s();
  // `untracked(queue)` would infer against a Signal's LAST call signature (the
  // setter, returning void), not the getter — an explicit thunk keeps the read.
  const append = <T>(queue: Signal<T[]>, item: T): void =>
    queue([...untracked(() => queue()), item]);
  const bump = (counter: Signal<number>): void => counter(untracked(() => counter()) + 1);
  /** Drains by replacement and hands the batch back. Silent when already empty. */
  const drain =
    <T>(queue: Signal<T[]>) =>
    (): T[] => {
      const batch = untracked(() => queue());
      if (batch.length === 0) return [];
      queue([]);
      return batch;
    };

  const visible = computed(() => {
    // Both reads happen unconditionally, before `.filter()` runs: an empty
    // `todos()` would otherwise never invoke the predicate, and `showDone`
    // would never become a dependency — the exact forwarding gap D16 bars.
    const needle = filterDraft().trim().toLowerCase();
    const includeDone = showDone();
    return todos().filter(
      (t) => (includeDone || !t.done) && (needle === "" || t.title.toLowerCase().includes(needle)),
    );
  });

  const view: TodoListView = Object.freeze({
    visible,
    filterDraft: reader(filterDraft),
    showDone: reader(showDone),
    lastOutcome: reader(lastOutcome),
    setFilter: (draft: string) => filterDraft(draft),
    setShowDone: (show: boolean) => showDone(show),
    requestRefresh: () => bump(refreshCount),
    requestClearCompleted: () => bump(clearCompletedCount),
    queueSubmit: (title: string) => append(pending, { title }),
    requestToggle: (id: string) => append(toggles, { id }),
    requestRemove: (id: string) => append(removals, { id }),
  });

  const control: TodoListControl = Object.freeze({
    edges: Object.freeze({
      refreshCount: reader(refreshCount),
      clearCompletedCount: reader(clearCompletedCount),
      pending: reader(pending),
      toggles: reader(toggles),
      removals: reader(removals),
    }),
    todos: reader(todos),
    takePending: drain(pending),
    takeToggles: drain(toggles),
    takeRemovals: drain(removals),
    replaceTodos: (list: Todo[]) => todos([...list]),
    reportOutcome: (outcome: string | undefined) => lastOutcome(outcome),
  });

  return Object.freeze({ view, control });
}
