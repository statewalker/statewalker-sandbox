import type { Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import { type TodoApi, todosAdd } from "@todo/core";
import type { TodoListModel } from "./todo-model.js";
import { ViewsReady } from "./views-ready.js";

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
  readonly debug = { reactions: 0, reloads: 0 };

  constructor(
    private readonly _model: TodoListModel,
    private readonly _commands: Commands,
    private readonly _api: TodoApi,
  ) {}

  /**
   * `ready` is only ever real when it came from `bootstrap()`, minted after
   * `registerViews` returned — the barrel exports `ViewsReady` as a type only
   * and B0 confines `_mint` to two files, so no caller can forge one (see
   * `views-ready.ts` for why a private constructor alone was not enough). This is the enforcement for
   * "a controller cannot be activated before the view layer is registered";
   * see `views-ready.ts` for why that has to live outside a comment.
   */
  activate(ready: ViewsReady): void {
    if (!(ready instanceof ViewsReady)) {
      throw new Error(
        "controller activated before the view layer was registered: obtain the " +
          "ready token from bootstrap(), which mints it only after registerViews has run.",
      );
    }
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
    // The initial load: `_handledRefresh` starts below any `refreshCount`.
    void this._reconcile();
  }

  async dispose(): Promise<void> {
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
      while (again) {
        again = false;
        const input = this._model.input;

        // EVENT edge: N queued items are N todos, and each carries its own
        // payload. `takePending()` drains by replacement inside the model — the
        // controller never assigns the field and never notifies (spec §4.8).
        const batch = input.takePending();
        if (batch.length > 0) {
          didWork = true;
          for (const item of batch) {
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
    if (didWork) this._model.reportOutcome(failure);
  }

  /** Never rejects: a failed list is a result, so the caller decides what it means. */
  private async _reload(): Promise<{ ok: true } | { ok: false; failure: string }> {
    this.debug.reloads++;
    try {
      const todos = await this._api.list();
      // One mutator, one notify. The controller does not know the field layout.
      this._model.replaceTodos(todos);
      return { ok: true };
    } catch (error) {
      return { ok: false, failure: `reload failed: ${reason(error)}` };
    }
  }
}
