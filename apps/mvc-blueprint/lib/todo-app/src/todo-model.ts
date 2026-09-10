import { BaseClass, onChangeNotifier } from "@statewalker/shared-baseclass";
import type { Todo } from "@todo/core";

/**
 * Re-exported for convenience, NOT re-declared. Declaring `Todo` here as well
 * would leave two `export *` barrels exporting one name, and TypeScript would
 * then export neither — the exact defect found in fm-protos' `PanelSpec`.
 */
export type { Todo };

/**
 * The user-input sub-model. The view writes ONLY here; the controller writes
 * only the outer model. Ownership is an object boundary, not a convention, and
 * that is what kills the reaction loop structurally (drive file 08 §2).
 *
 * Every field is classified — spec §4.2 — because the controller's obligation
 * differs by class and nothing else records which is which.
 */
export class TodoListInput extends BaseClass {
  /** Level — reconcile to the latest value. */
  filterDraft = "";
  /** Level. */
  showDone = true;
  /** State-latest edge — N bumps in one tick are ONE reload. */
  refreshCount = 0;
  /**
   * Event edge — N submissions are N todos, so the payload rides WITH the edge.
   * A counter beside a `title` level field would record two events and keep only
   * the second title (spec §4.2). Replaced on drain, never spliced.
   */
  pending: { title: string }[] = [];

  // --- Mutators. The view calls these; it never assigns a field and never
  // notifies (spec §4.8). Each says what happened, not which fields moved.

  setFilter(draft: string): void {
    if (this.filterDraft === draft) return; // no field change, no update
    this.filterDraft = draft;
    this.notify();
  }

  setShowDone(show: boolean): void {
    if (this.showDone === show) return;
    this.showDone = show;
    this.notify();
  }

  /** Raises the state-latest edge. Two calls in one tick are one reload. */
  requestRefresh(): void {
    this.refreshCount++;
    this.notify();
  }

  /** Raises an EVENT edge, carrying its payload — the counter alone could not. */
  queueSubmit(title: string): void {
    this.pending = [...this.pending, { title }];
    this.notify();
  }

  /**
   * Drains the queue by REPLACEMENT and hands the batch back, so the controller
   * never has to assign `pending` itself. Returns [] when there is nothing to do,
   * and does not notify in that case — no field change, no update.
   */
  takePending(): { title: string }[] {
    if (this.pending.length === 0) return [];
    const batch = this.pending;
    this.pending = [];
    this.notify();
    return batch;
  }

  // --- Named change channels (spec §4.10). A subscriber is woken only by the
  // change it asked for, so a controller writing `filterDraft` cannot wake a
  // controller watching for submissions. Declared as fields, because
  // `this.onUpdate` must be in scope; it is a bound arrow field on BaseClass and
  // base-class fields initialise first, so this is safe.
  //
  // NOTE: these narrow WHICH changes wake you, not HOW OFTEN — two bumps in one
  // tick fire twice. Coalescing remains the controller's watermark (§4.2).

  /** The state-latest edge. */
  onRefresh = onChangeNotifier(this.onUpdate, () => this.refreshCount);
  /** The event-edge queue. Identity comparison — which is why it is REPLACED. */
  onPendingChange = onChangeNotifier(this.onUpdate, () => this.pending);
  /** Both level fields that change the visible set, as one channel. */
  onQueryChange = onChangeNotifier(
    this.onUpdate,
    () => `${this.showDone ? "1" : "0"}\u0000${this.filterDraft}`,
  );
}

export class TodoListModel extends BaseClass {
  /** Written by the controller only, through `replaceTodos`. */
  todos: Todo[] = [];
  /** Outcomes go on the OUTER model, so a declined intent never wipes live typing. */
  lastOutcome?: string;
  readonly input = new TodoListInput();

  // --- Mutators. The controller calls these; it never assigns and never notifies.

  /** Replaced, never mutated: a selector comparing by identity sees nothing otherwise. */
  replaceTodos(todos: Todo[]): void {
    this.todos = [...todos];
    this.notify();
  }

  /** One intention, one notify — the list and its outcome never disagree on screen. */
  reportOutcome(outcome: string | undefined): void {
    if (this.lastOutcome === outcome) return; // no field change, no update
    this.lastOutcome = outcome;
    this.notify();
  }

  /** Identity comparison, which `replaceTodos` guarantees by never mutating. */
  onTodosChange = onChangeNotifier(this.onUpdate, () => this.todos);
  onOutcomeChange = onChangeNotifier(this.onUpdate, () => this.lastOutcome);

  /**
   * Derived, not stored: storing it would need invalidation on two level fields
   * and a list replacement, and every such cache is a second source of truth.
   */
  visible(): Todo[] {
    const needle = this.input.filterDraft.trim().toLowerCase();
    return this.todos.filter(
      (t) =>
        (this.input.showDone || !t.done) &&
        (needle === "" || t.title.toLowerCase().includes(needle)),
    );
  }
}
