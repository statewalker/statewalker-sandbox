import type { Command, Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import { type TodoApi, todosAdd } from "@todo/core";
import type { TodoListModel } from "./todo-model.js";
import { uiShowList } from "./ui-declarations.js";
import { ViewsReady } from "./views-ready.js";

/**
 * What `panelSettled` carries once the panel command settles. Never
 * rejects — see the field's own doc for why a plain `Promise<void>` would
 * be the wrong shape here.
 */
export type PanelOutcome = { ok: true } | { ok: false; error: unknown };

/** What a failure says to the user. A `CommandError`'s message already names its kind and key. */
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Owns the external service and the bus; never sees a view.
 *
 * Reads go straight through `TodoApi`; writes go through commands, so a host
 * can override an operation without the controller knowing. That asymmetry is
 * deliberate — reading is not an operation anyone overrides.
 *
 * It subscribes to `model.input` and writes `model` — never the reverse — so
 * its own writes cannot wake it. That is the whole reason the input sub-model
 * exists, and `expectNoSelfWake` asserts both halves of it.
 *
 * ERROR POLICY. Every piece of work runs inside `_reconcile()`, which is fired
 * with `void` from a channel callback — so a rejection escaping it has nowhere
 * to go but the process, and nothing reaches the user. Therefore nothing
 * escapes: each failure is caught where it happens and reported through the
 * outer model's `reportOutcome` (the mutator that exists for exactly this), and
 * a watermark moves only once the work it stands for has actually landed.
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
    register(
      this._model.input.onPendingChange(() => {
        this.debug.reactions++;
        void this._reconcile();
      }),
    );

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
   * same tick, or from `takePending()`'s own notify) folds into that run instead
   * of starting a second one — the running loop re-reads both edges after every
   * await, so nothing it would have done is lost.
   *
   * Never rejects. Its callers `void` it, so a failure is reported through the
   * model instead: once, at the end of the run, as the outcome of the work the
   * run did. A run that did work and hit no failure clears the outcome, because
   * the failure it described is no longer the latest word; a run that did
   * nothing leaves it alone.
   */
  private async _reconcile(): Promise<void> {
    if (this._reconciling) return;
    this._reconciling = true;
    let failure: string | undefined;
    let didWork = false;
    // A reload that failed is not retried within the same run: the backend is
    // down, and looping on it would spin. It stays OWED (the watermark did not
    // move), so the next run — one bump, or any other edge — repays it.
    let refreshFailed = false;
    try {
      let again = true;
      while (again && !this._disposed) {
        again = false;
        const input = this._model.input;

        // EVENT edge: N queued items are N todos, and each carries its own
        // payload. `takePending()` drains by replacement inside the model — the
        // controller never assigns the field and never notifies (spec §4.8).
        const batch = input.takePending();
        if (batch.length > 0) {
          didWork = true;
          for (const item of batch) {
            // Disposed mid-batch: issue no further commands for a model
            // nobody owns any more. The rest of the batch is abandoned with it.
            if (this._disposed) break;
            try {
              await this._commands.call(todosAdd, { title: item.title }).promise;
            } catch (error) {
              // Not retried: a rejected payload (the schema, a host's veto) is
              // rejected again. It is taken off the queue and the user is told
              // which one — the title rides in the outcome, so it is not lost.
              failure ??= `add "${item.title}" failed: ${reason(error)}`;
            }
          }
          const reloaded = await this._reload();
          if (!reloaded.ok) failure ??= reloaded.failure;
          again = true; // more may have been queued while we were awaiting
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
