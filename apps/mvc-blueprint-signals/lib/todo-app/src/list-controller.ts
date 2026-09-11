import type { Command, CommandDeclaration, Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import { type TodoApi, todosAdd, todosClearCompleted, todosRemove, todosToggle } from "@todo/core";
import type { TodoListModel } from "./todo-model.js";
import { ConfirmModel, NotifyModel, uiConfirm, uiNotify, uiShowList } from "./ui-declarations.js";
import { ViewsReady } from "./views-ready.js";

/**
 * What `panelSettled` carries once the panel command settles. Never
 * rejects — see the field's own doc for why a plain `Promise<void>` would
 * be the wrong shape here.
 */
export type PanelOutcome = { ok: true } | { ok: false; error: unknown };

/** What a failure says to the user. A `CommandError`'s message already names its kind and key. */
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** "1 completed todo", "3 completed todos". */
const completedTodos = (n: number): string => `${n} completed todo${n === 1 ? "" : "s"}`;

/**
 * Owns the external service and the bus; never sees a view.
 *
 * Reads go straight through `TodoApi`; writes go through commands, so a host
 * can override an operation without the controller knowing. That asymmetry is
 * deliberate — reading is not an operation anyone overrides.
 *
 * It subscribes to `model.input` and writes its RESULTS to `model`, so those
 * writes cannot wake it. Its one write to `input` is draining it — each
 * `take*()` replaces a queue and notifies, which does wake its own channel —
 * and that happens inside a run, where the `_reconciling` guard absorbs it.
 * That split is the reason the input sub-model exists, and `expectNoSelfWake`
 * asserts both halves of it: an outer write does not wake it, an input write
 * does.
 *
 * ERROR POLICY. Every piece of work runs inside `_reconcile()`, which is fired
 * with `void` from a channel callback — so a rejection escaping it has nowhere
 * to go but the process, and nothing reaches the user. Therefore nothing
 * escapes: each failure is caught where it happens and reported through the
 * outer model's `reportOutcome` (the mutator that exists for exactly this), and
 * a watermark moves once the user's intent is CONSUMED. For work with no
 * question in it — a reload — that is when the work landed: a failed reload
 * leaves its watermark where it was. For an intent that asks the user a
 * question — clear-completed — the answer consumes it, whatever follows (see
 * `_handledClearCompleted`).
 *
 * ONE exception: the panel command's own rejection (`activate()`'s
 * `commands.call(uiShowList, ...)` finding no view layer) does NOT go through
 * `reportOutcome` — see `panelSettled`'s doc for why that channel is the wrong
 * fit for a wiring bug rather than a transient failure.
 */
export class ListController {
  private readonly _registry = newRegistry();
  /**
   * The `refreshCount` the model's list last reflects. Starts at -1, "nothing
   * loaded yet", so the initial load is not a special path: it is the first
   * refresh owed, reconciled by the same loop, under the same error policy —
   * and a failed initial load stays owed, exactly like a failed refresh.
   */
  private _handledRefresh = -1;
  /**
   * The `clearCompletedCount` whose intent has been CONSUMED. Starts at 0 —
   * unlike `_handledRefresh`, nothing is owed at startup.
   *
   * The rule, stated precisely: a watermark moves once the user's intent is
   * consumed — and for an intent that asks the user a question, the ANSWER is
   * the consumption. Yes or no, and whether or not the clear that follows a
   * yes succeeds (a failure is reported, and the user retries by pressing
   * again). An intent with nothing to ask about is consumed without asking.
   * Only a question that was never answered — the confirm itself failed —
   * leaves it owed. See `_clearCompleted()` for WHEN the target is read,
   * which is what makes two quick presses one dialog.
   */
  private _handledClearCompleted = 0;
  /**
   * True while a `_reconcile()` run is in flight — what makes coalescing
   * leading + trailing rather than absent. `notify()` is synchronous (spec:
   * `@statewalker/shared-baseclass`), so N `requestRefresh()` calls with no
   * gap fire `onRefresh` N times before the first run's `await` ever
   * suspends; a watermark alone cannot help, because all N calls clear it
   * before any of them awaits. This flag turns every one of those synchronous
   * re-entries (including the nested one from `takePending()`'s own notify)
   * into a no-op, so only the FIRST pulse reloads immediately (leading edge).
   * The in-flight run then loops, re-reading both edges after every await, so
   * whatever arrived while it was busy is folded into exactly ONE follow-up
   * pass carrying the newest state (trailing edge) — never zero (nothing
   * lost) and never more than one (real coalescing, not N reloads).
   */
  private _reconciling = false;
  private _activated = false;
  /**
   * Set first thing in `dispose()`. Checked after every await, so work that was
   * already in flight when teardown began drops its write instead of landing
   * on a model whose owner was told teardown is complete.
   */
  private _disposed = false;
  readonly debug = { reactions: 0, reloads: 0 };
  /**
   * The long-lived `ui:show-list` command `activate()` shows and `dispose()`
   * settles. Held here (not fired-and-forgotten) for two reasons: `dispose()`
   * needs a handle to resolve it closed, and nothing else in this class ever
   * touches it, so there is no other honest owner.
   */
  private _panel?: Command<TodoListModel, { closed: boolean }>;
  /**
   * Settles once — when the panel command does, which in the healthy case is
   * only at `dispose()`. NEVER rejects itself: the panel command's rejection
   * (almost certainly `no-handlers` — no view layer registered) is carried as
   * DATA (`{ ok: false, error }`), not as a rejection, so a caller who never
   * reads this field can never turn its mere existence into an unhandled
   * rejection. `panel.promise` itself, though, gets a rejection handler
   * SYNCHRONOUSLY inside `activate()` — in the same tick `commands.call()`
   * ran in — which is what keeps that one from ever going unhandled either.
   *
   * This exists because `activate()` is synchronous and cannot throw a
   * rejection that arrives after it returns, and because the file's usual
   * channel for a failure — `reportOutcome` — is the wrong fit here: it is
   * cleared by the very next successful reconcile (by design, so a stale
   * failure does not linger once the thing it described stopped being true),
   * and the initial load succeeding is the common case even when NO view
   * layer is registered. A `no-handlers` wiring bug does not go away because
   * the list still loaded; folding it into `reportOutcome` would erase it
   * within one tick almost every time. `panelSettled` is the honest,
   * un-clobbered record instead — read by a test (and available to any real
   * host that wants to know) via `await controller.panelSettled`.
   */
  panelSettled: Promise<PanelOutcome> = Promise.resolve({ ok: true });

  constructor(
    private readonly _model: TodoListModel,
    private readonly _commands: Commands,
    private readonly _api: TodoApi,
  ) {}

  /**
   * `ready` is only ever real when it came from `bootstrap()`, minted after
   * `registerViews` returned. This is the enforcement for "a controller cannot
   * be activated before the view layer is registered". What stops a caller
   * forging one is the type-only barrel plus two B0 greps, not the private
   * constructor alone — `views-ready.ts` says why.
   */
  activate(ready: ViewsReady): void {
    if (!(ready instanceof ViewsReady)) {
      throw new Error(
        "controller activated before the view layer was registered: obtain the " +
          "ready token from bootstrap(), which mints it only after registerViews has run.",
      );
    }
    // A second activate() — or one after dispose() — would subscribe every
    // channel again, and each edge would then start two runs.
    if (this._activated) {
      throw new Error(
        "controller already activated: activate() subscribes its channels, so it runs once.",
      );
    }
    this._activated = true;
    const [register] = this._registry;
    // Subscribed to NAMED CHANNELS, never to bare `onUpdate` (spec §4.10): a
    // write to `filterDraft` must not wake the code that reloads from the api.
    // Registered here, not lazily on first render — a headless controller is a
    // first-class case, not a degenerate one (fm-protos C3 found this the hard way).
    register(
      this._model.input.onRefresh(() => {
        this.debug.reactions++;
        void this._reconcile();
      }),
    );
    // Every input edge wakes the SAME loop: one `_reconcile()`, one
    // `_reconciling` guard, one error policy. A second loop per edge would
    // race the first over the model it writes. The price — everything waits
    // behind an open dialog — is in `_reconcile()`'s doc.
    for (const channel of [
      this._model.input.onPendingChange,
      this._model.input.onTogglesChange,
      this._model.input.onRemovalsChange,
      this._model.input.onClearCompleted,
    ]) {
      register(
        channel(() => {
          this.debug.reactions++;
          void this._reconcile();
        }),
      );
    }

    // The design's central sentence, made true for the list: "a controller
    // emits ui:show-*(model); the adapter claims it, renders, and unmounts
    // when the command settles." Shown ONCE, held open — never settled here —
    // because this is a panel, not a dialog: it has no answer to wait for, so
    // the only thing that ever settles it is `dispose()`, on teardown.
    //
    // `uiShowList`'s input schema (`z.custom<TodoListModel>()`) validates
    // synchronously, so `commands.call` dispatches to listeners — and, with
    // none registered, rejects with `no-handlers` — before this line returns.
    // The `.then` below is attached in that same synchronous turn, which is
    // what keeps a `no-handlers` rejection (or, later, `ViewAdapter.dispose()`
    // force-rejecting this same command) from ever being unhandled: Node/the
    // browser only flags a rejection as unhandled if NOTHING is listening by
    // the end of the current microtask turn, and by then this already is.
    const panel = this._commands.call(uiShowList, this._model);
    this._panel = panel;
    this.panelSettled = panel.promise.then(
      (): PanelOutcome => ({ ok: true }),
      (error: unknown): PanelOutcome => ({ ok: false, error }),
    );

    // The initial load: `_handledRefresh` starts below any `refreshCount`.
    void this._reconcile();
  }

  /**
   * WRITE-quiescent, not call-quiescent: once this resolves, the controller
   * will never write the model again — but a run already in flight when
   * teardown began may still be executing, and if the api it is awaiting
   * answers later, that answer is dropped rather than applied. Unsubscribing
   * stops NEW work; `_disposed` (set first, checked after every await) is
   * what makes an in-flight run drop its write instead of landing on a model
   * whose owner was told teardown is complete. `ViewAdapter.dispose()` is
   * symmetric in the same way, for the same reason.
   *
   * This used to also wait for every in-flight run to settle before
   * resolving — a stronger, CALL-quiescent guarantee. That guarantee was
   * withdrawn because it deadlocks: `bootstrap`'s registry unwinds LIFO, so a
   * controller (registered by `createList`, after `registerViews`) is
   * disposed BEFORE the view layer that registered it. A run stuck awaiting a
   * command only the view layer settles — the canonical case being a host
   * routing `todos:add` through an approval dialog — then has no path to ever
   * settle: the one thing that WOULD unstick it, the view layer's own
   * `dispose()` (which force-rejects whatever is still open), does not run
   * until this `dispose()` has already returned. Waiting for such a run
   * waits forever. Dropping the wait costs nothing this method still
   * promises: `_disposed` alone already guarantees no write reaches the
   * model after teardown, which is the guarantee the earlier fix actually
   * needed.
   *
   * Settling the panel is deliberately SYNCHRONOUS and un-awaited, for the
   * exact reason the paragraph above gives up the run-quiescent guarantee:
   * awaiting anything here reintroduces the deadlock Task 10 removed. Calling
   * `resolve()` is enough — the bus validates `{ closed: true }` against
   * `uiShowList`'s output schema (`z.object({ closed: z.boolean() })`)
   * synchronously (zod, no async refinement), so the command is fully settled
   * before this line finishes, and `ViewAdapter`'s `cmd.promise.then(...)`
   * reaction (which unmounts the view) is scheduled to run on the very next
   * microtask turn — no wait needed for that either.
   *
   * Idempotent with `ViewAdapter.dispose()` also touching this command: read
   * from `@statewalker/shared-commands`' `command.ts`, both `resolve()` and
   * `reject()` start with `if (cmd.settled) return;` — a settled-guard on the
   * bus itself, not an assumption made here. In the normal LIFO order this
   * controller's `dispose()` always runs before the view layer's, so this
   * `resolve()` is the one that wins and the adapter's later `reject()` (for
   * whatever is still open at ITS dispose) is the no-op. Were the order ever
   * reversed, the adapter's `reject()` would win instead and this `resolve()`
   * would be the no-op — either way, no throw, no double-settle.
   */
  async dispose(): Promise<void> {
    this._disposed = true;
    this._panel?.resolve({ closed: true });
    const [, cleanup] = this._registry;
    await cleanup();
  }

  /**
   * Idempotent: it may run on every notify and must do nothing when no field it
   * cares about has changed. Re-entrant-safe: a call that arrives while a run is
   * already in flight (the synchronous re-entry from a second `notify()` in the
   * same tick, or from a `take*()` drain's own notify) folds into that run
   * instead of starting a second one — the running loop re-reads every edge
   * after every await, so nothing it would have done is lost.
   *
   * Never rejects. Its callers `void` it, so a failure is reported through the
   * model instead: once, at the end of the run, as the outcome of the work the
   * run did. A run that did work and hit no failure clears the outcome, because
   * the failure it described is no longer the latest word; a run that did
   * nothing leaves it alone.
   *
   * ONE LOOP, AND WHAT IT COSTS. Every edge is drained here, one step after
   * another, and a step may await a command only a VIEW settles. While the
   * clear-completed confirm is open, a queued add, a toggle and a refresh all
   * sit undrained until the user answers — the in-flight guard folds their
   * wakes into a run that is parked on the dialog. The modal hides that here:
   * nobody can press anything behind it. It would not hide it for a host that
   * routes `todos:add` through an approval dialog, or for the Files Manager's
   * conflict dialogs: one open question would freeze the whole controller.
   * Deferred, not solved (DECISIONS.md, Deferred); the likely direction is to
   * await view-settled commands OUTSIDE this loop and feed each answer back
   * in as an edge.
   */
  private async _reconcile(): Promise<void> {
    if (this._reconciling) return;
    this._reconciling = true;
    let failure: string | undefined;
    let didWork = false;
    // A reload that failed is not retried within the same run: the backend is
    // down, and looping on it would spin. It stays OWED (the watermark did not
    // move), so the next run — one bump, or any other edge — repays it.
    //
    // Clear-completed does NOT follow this rule once the user has answered,
    // and the difference is deliberate. A reload is invisible and idempotent,
    // so repaying it on whatever edge next wakes the loop is free and silent.
    // Repaying a clear would re-open a MODAL confirm for someone who already
    // answered, on an unrelated edge — a toggle popping the dialog back up.
    // So for a clear, the answer consumes the intent (see
    // `_handledClearCompleted`); only a question that could not be asked at
    // all stays owed, and `clearOwed` stops this run from trying again at once.
    let refreshFailed = false;
    let clearOwed = false;
    try {
      let again = true;
      while (again && !this._disposed) {
        again = false;
        const input = this._model.input;

        // EVENT edges: N queued items are N commands, and each carries its own
        // payload — adds a title, toggles and deletes a row id. `take*()`
        // drains by replacement inside the model — the controller never
        // assigns the field and never notifies (spec §4.8). All three queues
        // are taken together and answered by ONE reload.
        //
        // Order across queues is adds, then toggles, then deletes — not press
        // order, which three queues do not record. No gesture depends on it:
        // an add has no id to toggle yet, and a toggle and a delete of one row
        // end with the row gone either way.
        const adds = input.takePending();
        const toggles = input.takeToggles();
        const removals = input.takeRemovals();
        if (adds.length + toggles.length + removals.length > 0) {
          didWork = true;
          // Not retried: a rejected payload (the schema, a host's veto, a
          // backend refusal) is rejected again. Each item is taken off its
          // queue and the user is told which one — the title or id rides in
          // the outcome, so it is not lost. Assigned through a local, never
          // `failure ??= await …`: `??=` would SKIP the call once a failure
          // is recorded, silently dropping every later item in the batch.
          for (const { title } of adds) {
            const failed = await this._send(todosAdd, { title }, `add "${title}"`);
            failure ??= failed;
          }
          for (const { id } of toggles) {
            const failed = await this._send(todosToggle, { id }, `toggle "${id}"`);
            failure ??= failed;
          }
          for (const { id } of removals) {
            const failed = await this._send(todosRemove, { id }, `remove "${id}"`);
            failure ??= failed;
          }
          const reloaded = await this._reload();
          if (!reloaded.ok) failure ??= reloaded.failure;
          again = true; // more may have been queued while we were awaiting
        }

        // STATE-LATEST edge, through a dialog: confirm, clear, notify. Checked
        // after the event edges, so a toggle pressed before "clear completed"
        // has landed before the question counts what is completed.
        if (!clearOwed && input.clearCompletedCount > this._handledClearCompleted) {
          const completed = this._model.todos.filter((t) => t.done).length;
          if (completed === 0) {
            // A question with no content is not asked — of a user, a host, or
            // an agent raising this intent through the command surface; a
            // view disabling its button cannot speak for the other two. The
            // intent is consumed on the spot: no dialog, no command, no toast,
            // no model write, so it is not counted as work either.
            this._handledClearCompleted = input.clearCompletedCount;
          } else {
            didWork = true;
            const clear = await this._clearCompleted(completed);
            if (clear.consumed !== undefined) this._handledClearCompleted = clear.consumed;
            else clearOwed = true;
            failure ??= clear.failure;
            again = true; // we awaited: anything may have arrived meanwhile
          }
        }

        // STATE-LATEST edge, coalesced leading + trailing: compare against a
        // watermark, not a boolean, and jump to the newest value. The first
        // pulse reloads immediately; every pulse arriving while that reload is
        // in flight folds into ONE follow-up pass that re-reads the counter, so
        // the newest state always wins and no bump is lost. Five bumps in a
        // tick are two reloads, not five and not one. A watermark alone cannot
        // do this: notify() is synchronous, so all five pulses clear the
        // watermark before any of them awaits — the `_reconciling` guard above
        // is what turns the extra synchronous calls into the single follow-up.
        if (!refreshFailed && input.refreshCount > this._handledRefresh) {
          didWork = true;
          // Captured BEFORE the await, committed only AFTER it succeeds. Bumps
          // arriving mid-flight stay above `target`, so they earn the trailing
          // pass; and a reload that throws leaves the watermark where it was,
          // so the refresh is still owed rather than falsely marked as done.
          const target = input.refreshCount;
          const reloaded = await this._reload();
          if (reloaded.ok) {
            this._handledRefresh = target;
          } else {
            refreshFailed = true;
            failure ??= reloaded.failure;
          }
          again = true; // we awaited: anything may have arrived meanwhile
        }
      }
    } catch (error) {
      // Nothing above should throw — every await is guarded — but the policy
      // is "nothing escapes a `void`", not "nothing escapes that we foresaw".
      failure ??= `reconcile failed: ${reason(error)}`;
      didWork = true;
    } finally {
      this._reconciling = false;
    }
    if (didWork && !this._disposed) this._model.reportOutcome(failure);
  }

  /**
   * One command of an event batch. Never rejects: returns the failure to
   * report, or `undefined`. Disposed mid-batch: issues nothing further for a
   * model nobody owns any more — the rest of the batch is abandoned with it.
   */
  private async _send<P>(
    decl: CommandDeclaration<P, unknown>,
    payload: P,
    what: string,
  ): Promise<string | undefined> {
    if (this._disposed) return undefined;
    try {
      await this._commands.call(decl, payload).promise;
      return undefined;
    } catch (error) {
      return `${what} failed: ${reason(error)}`;
    }
  }

  /**
   * The spec §5 chain on a real feature: a short-lived view (confirm), a
   * command, and a fire-and-forget view (notify). Never rejects. `completed`
   * is the model's count, and is never 0 — the caller skips an empty question.
   *
   * `consumed` is the `clearCompletedCount` whose intent this pass consumed:
   * set as soon as the user has answered, whatever follows — a decline, a
   * clear that lands, or a clear that fails (reported through `failure`, and
   * never re-asked; the user retries by pressing again). It is `undefined`
   * only when the question itself failed and so was never answered: then
   * the edge stays owed.
   *
   * WHY THE TARGET IS READ AFTER THE ANSWER, not before the question (where
   * `refreshCount`'s is read). A state-latest edge captures its target at the
   * moment the work observes the state: a reload observes the backend when it
   * starts, so a bump after that start needs the trailing pass. Here the work
   * observes the USER, and it does so when the answer arrives — so every
   * press made while the dialog was open is already covered by that answer,
   * and asking again would be the second dialog that two quick presses must
   * not open. A press after the answer (while the clear is in flight) is
   * above the target, and earns exactly one follow-up dialog: coalesced,
   * never lost.
   *
   * TEARDOWN. `dispose()` does not wait for any of this, so nothing here may
   * depend on being unstuck in time. If teardown starts while the dialog is
   * open, this run stays suspended until someone settles the confirm:
   * `ViewAdapter.dispose()` force-rejects it (caught below), and a view layer
   * that never settles it leaves the run suspended for good — harmless,
   * because the model is written only after a `_disposed` check (here, in
   * `_reload()`, and in the loop), whichever settles first and in whichever
   * order the registry tears things down.
   */
  private async _clearCompleted(completed: number): Promise<{ consumed?: number; failure?: string }> {
    let confirmed: boolean;
    try {
      const question = new ConfirmModel(`Clear ${completedTodos(completed)}?`);
      ({ confirmed } = await this._commands.call(uiConfirm, question).promise);
    } catch (error) {
      return { failure: `confirm failed: ${reason(error)}` };
    }
    // The answer consumes every press made up to now — see above.
    const consumed = this._model.input.clearCompletedCount;
    if (this._disposed) return { consumed };
    if (!confirmed) return { consumed };

    let cleared: number;
    try {
      ({ cleared } = await this._commands.call(todosClearCompleted, {}).promise);
    } catch (error) {
      // Answered, so consumed: reported once, never re-asked.
      return { consumed, failure: `clear completed failed: ${reason(error)}` };
    }
    if (this._disposed) return { consumed };

    // Fire-and-forget: the toast settles itself, so it is not awaited — a
    // controller waiting out a timeout would stall every other edge behind
    // it. Its rejection still gets a handler, attached in this same turn, so
    // it can never go unhandled. What the handler's result MEANS depends only
    // on timing, never on teardown order:
    // - A DISPATCH-time failure (`no-handlers`: no notify view) rejects
    //   synchronously inside `call()`, so its handler is queued before the
    //   reload's continuation, has run by the time the reload returns, and is
    //   folded into this run's outcome below.
    // - ANY later rejection (a view layer force-closing an open toast, or a
    //   view rejecting it) lands in `notifyFailed` after this method has
    //   already returned and nobody reads it again — so it is dropped. That
    //   is deliberate: the clear it announced has already landed and been
    //   reported, and a toast that failed to finish showing is not news.
    let notifyFailed: string | undefined;
    const note = this._commands.call(uiNotify, new NotifyModel(`Cleared ${completedTodos(cleared)}`));
    note.promise.then(undefined, (error: unknown) => {
      notifyFailed = `notify failed: ${reason(error)}`;
    });

    const reloaded = await this._reload();
    return { consumed, failure: notifyFailed ?? (reloaded.ok ? undefined : reloaded.failure) };
  }

  /** Never rejects: a failed list is a result, so the caller decides what it means. */
  private async _reload(): Promise<{ ok: true } | { ok: false; failure: string }> {
    this.debug.reloads++;
    try {
      const todos = await this._api.list();
      // Disposed while the api was answering: drop the write. The run checks
      // `_disposed` too and stops, so nobody acts on this result.
      if (this._disposed) return { ok: true };
      // One mutator, one notify. The controller does not know the field layout.
      this._model.replaceTodos(todos);
      return { ok: true };
    } catch (error) {
      return { ok: false, failure: `reload failed: ${reason(error)}` };
    }
  }
}
