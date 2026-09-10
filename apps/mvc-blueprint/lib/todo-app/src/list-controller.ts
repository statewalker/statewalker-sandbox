import type { Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import { type TodoApi, todosAdd } from "@todo/core";
import type { TodoListModel } from "./todo-model.js";

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
 */
export class ListController {
  private readonly _registry = newRegistry();
  private _handledRefresh = 0;
  /**
   * True while a `_reconcile()` run is in flight. `notify()` is synchronous
   * (spec: `@statewalker/shared-baseclass`), so two `requestRefresh()` calls in
   * one tick fire `onRefresh` twice before either await suspends. Without this
   * guard, the second synchronous re-entry would see the watermark already
   * bumped by the first and race off a second reload — coalescing would only
   * work when the caller happened to await between bumps, which is not what
   * "one tick" means. The in-flight run re-checks both edges in a loop after
   * every await, so it still picks up whatever changed while it was awaiting.
   */
  private _reconciling = false;
  readonly debug = { reactions: 0, reloads: 0 };

  constructor(
    private readonly _model: TodoListModel,
    private readonly _commands: Commands,
    private readonly _api: TodoApi,
  ) {}

  activate(): void {
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
    void this._reload();
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
   */
  private async _reconcile(): Promise<void> {
    if (this._reconciling) return;
    this._reconciling = true;
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
          for (const item of batch) {
            await this._commands.call(todosAdd, { title: item.title }).promise;
          }
          await this._reload();
          again = true; // more may have been queued while we were awaiting
        }

        // STATE-LATEST edge: compare against a watermark, not a boolean, and
        // jump to the newest value — two presses in one tick are one reload of
        // the newest state.
        if (input.refreshCount > this._handledRefresh) {
          this._handledRefresh = input.refreshCount;
          await this._reload();
          again = true;
        }
      }
    } finally {
      this._reconciling = false;
    }
  }

  private async _reload(): Promise<void> {
    this.debug.reloads++;
    // One mutator, one notify. The controller does not know the field layout.
    this._model.replaceTodos(await this._api.list());
  }
}
