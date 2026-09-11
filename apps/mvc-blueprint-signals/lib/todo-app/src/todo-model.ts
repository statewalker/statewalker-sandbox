import { BaseClass, onChangeNotifier } from "@statewalker/shared-baseclass";
import type { Todo } from "@todo/core";

/**
 * Re-exported for convenience, NOT re-declared. Declaring `Todo` here as well
 * would leave two `export *` barrels exporting one name, and TypeScript would
 * then export neither — the exact defect found in fm-protos' `PanelSpec`.
 */
export type { Todo };

/**
 * The user-input sub-model. Intent flows IN through here and results flow OUT
 * through the outer model — that direction is what kills the reaction loop
 * (drive file 08 §2):
 *
 * - The view writes here, and only here, through the view-side mutators
 *   (`set*`, `request*`, `queueSubmit`).
 * - The controller writes the outer model through ITS mutators, and touches
 *   this object only to drain it: each `take*()` replaces a queue and
 *   notifies, which DOES wake the controller's own channel. That wake is
 *   harmless because it happens inside a run: the in-flight guard
 *   (`ListController._reconciling`) turns it into a no-op, and the run
 *   re-reads every edge before it ends anyway.
 *
 * The object split is not what ENFORCES this — a view holds the outer model
 * and could call `replaceTodos` on it. The split is what makes it CHECKABLE:
 * "who may call what" becomes a list of method names, and B0 checks it — only
 * as far as its patterns reach. A `todo-ui` file may not name a controller-
 * side method (every model method but the view-side mutators, `visible` and
 * `toJSON`), and nothing outside a model may assign a field through a
 * receiver whose name contains "model". A computed method name, or an alias
 * (`const i = model.input; i.pending = []`), walks past both.
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
  /**
   * Event edge — a toggle is an action on ONE row, so the id rides with it:
   * two toggles on two rows are two actions, and a counter beside a
   * "selected id" level field would keep only the second (spec §4.2).
   * Two toggles on the SAME row are two actions too — never deduplicated.
   * Replaced on request and on drain, never spliced (spec §4.10 property 2).
   */
  toggles: { id: string }[] = [];
  /** Event edge — same reasoning as `toggles`: every delete is honoured. */
  removals: { id: string }[] = [];
  /**
   * State-latest edge — "clear completed" names no row; it asks for a STATE
   * (no completed todos). Two quick presses must open ONE confirm dialog, not
   * two, so this is a counter the controller coalesces against a watermark,
   * not a queue it honours item by item. The counter still rises on every
   * press: coalescing is the controller's job, never the model's.
   */
  clearCompletedCount = 0;

  // --- Mutators. The view calls the `set*`/`request*`/`queueSubmit` ones; the
  // controller calls only the `take*()` drains. Neither assigns a field or
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
   * and does not notify in that case — no field change, no update. When it does
   * notify, it wakes the draining controller's own `onPendingChange`, which its
   * in-flight guard absorbs (see the class doc). Controller-side: B0 bars views.
   */
  takePending(): { title: string }[] {
    if (this.pending.length === 0) return [];
    const batch = this.pending;
    this.pending = [];
    this.notify();
    return batch;
  }

  /**
   * Raises an EVENT edge carrying the row id. No compare-before-write: every
   * call IS a change (a new queue entry), so there is nothing to skip.
   */
  requestToggle(id: string): void {
    this.toggles = [...this.toggles, { id }];
    this.notify();
  }

  /** Drains `toggles` exactly as `takePending` drains `pending`. */
  takeToggles(): { id: string }[] {
    if (this.toggles.length === 0) return []; // no field change, no update
    const batch = this.toggles;
    this.toggles = [];
    this.notify();
    return batch;
  }

  /** Raises an EVENT edge carrying the row id — see `requestToggle`. */
  requestRemove(id: string): void {
    this.removals = [...this.removals, { id }];
    this.notify();
  }

  /** Drains `removals` exactly as `takePending` drains `pending`. */
  takeRemovals(): { id: string }[] {
    if (this.removals.length === 0) return []; // no field change, no update
    const batch = this.removals;
    this.removals = [];
    this.notify();
    return batch;
  }

  /**
   * Raises the state-latest edge. Like `requestRefresh`, no compare-before-
   * write: the counter moves on every call by definition. Two calls in one
   * tick are one confirm dialog — the controller's watermark sees to that.
   */
  requestClearCompleted(): void {
    this.clearCompletedCount++;
    this.notify();
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
  /** The toggle queue — identity comparison, so it is REPLACED. */
  onTogglesChange = onChangeNotifier(this.onUpdate, () => this.toggles);
  /** The delete queue — identity comparison, so it is REPLACED. */
  onRemovalsChange = onChangeNotifier(this.onUpdate, () => this.removals);
  /** The clear-completed state-latest edge. */
  onClearCompleted = onChangeNotifier(this.onUpdate, () => this.clearCompletedCount);
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

  constructor() {
    super();
    // `visible()` reads the input's QUERY fields, and `input.notify()` never
    // reaches this model's `onUpdate` on its own. That channel must cover
    // every derived getter this model exposes, or a view bound through
    // `useModel(model, m => m.visible())` goes stale with no error — a
    // "Show completed" that stops filtering, a count badge that stops
    // counting. So the QUERY channel is forwarded, and nothing else: the
    // add-form and row queues feed the controller, and the outer model
    // derives nothing from them.
    //
    // No loop and no self-wake: this notifies the OUTER model, which writes
    // nothing back to `input`; the controller subscribes to input CHANNELS,
    // never to the outer `onUpdate`. The subscription lives exactly as long
    // as the two objects it joins, which are one lifetime — so it has no
    // disposer to own.
    this.input.onQueryChange(() => this.notify());
  }

  // --- Mutators. The controller calls these; it never assigns and never
  // notifies. A view never calls them — B0's "todo-ui never names a
  // controller-side model method".

  /** Replaced, never mutated: a selector comparing by identity sees nothing otherwise. */
  replaceTodos(todos: Todo[]): void {
    this.todos = [...todos];
    this.notify();
  }

  /**
   * The outcome of the controller's latest piece of work: a failure's message,
   * or `undefined` once work has succeeded since. Written by the controller at
   * the END of a run, after the list — so a subscriber can see the new list
   * beside the previous outcome for one synchronous notify. A combined mutator
   * would close that; it is not needed until a view renders both from one read.
   */
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
