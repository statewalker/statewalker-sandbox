import type { Commands } from "@statewalker/shared-commands";
import { getLogger, type Logger } from "@statewalker/shared-logger";
import { newRegistry } from "@statewalker/shared-registry";
import type { Slots } from "@statewalker/shared-slots";
import {
  type AppContext,
  dialogsSlot,
  getCommands,
  getSlots,
  panelsSlot,
  runningOperationsSlot,
} from "@sys";
import {
  getTodoApi,
  type TodoApi,
  todosAdd,
  todosClearCompleted,
  todosRemove,
  todosSummary,
  todosToggle,
} from "@todo/core";
import { createConfirmDialogModel } from "./confirm-dialog-model.js";
import { type ConfirmDialogControl, confirmDialogKind, todoListKind } from "./models.js";
import { createSampleOperation } from "./sample-operation.js";
import { createTodoListModel } from "./todo-list-model.js";

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface TodoControllerOptions {
  /** Pause between sample todos, so the progress bar has something to show. */
  sampleDelayMs?: number;
}

/**
 * Owns the todo list. Publishes its panel into `ui:panels`, its question into
 * `ui:dialogs`, its long work into `ops:running`; writes through commands and
 * logs each fact once the command landed; answers `todos:summary`.
 *
 * One reconcile loop drains every intent. It NEVER awaits a view: a dialog's
 * answer is an edge the next pass drains, so an open question blocks nothing.
 * Re-entrant wakes set `_rerun`, so work arriving during an await is picked up
 * by the pass in flight (leading + trailing).
 */
export class TodoController {
  readonly model = createTodoListModel();
  readonly debug = { reloads: 0 };
  private readonly _registry = newRegistry();
  private _commands!: Commands;
  private _slots!: Slots;
  private _api!: TodoApi;
  private _log!: Logger;
  private _reconciling = false;
  private _rerun = false;
  private _disposed = false;
  private _loadOwed = true;
  private _handledClear = 0;
  private _dialog?: { control: ConfirmDialogControl; release: () => void };

  constructor(private readonly _options: TodoControllerOptions = {}) {}

  activate(ctx: AppContext): void {
    const [register] = this._registry;
    this._commands = getCommands(ctx);
    this._slots = getSlots(ctx);
    this._api = getTodoApi(ctx);
    this._log = getLogger(ctx).child({ module: "todos" });
    register(() => this.model.dispose());
    register(
      this._commands.listen(todosSummary, async () => {
        const todos = await this._api.list();
        return { total: todos.length, done: todos.filter((t) => t.done).length };
      }),
    );
    register(
      this._slots.register(panelsSlot, "todos:list", {
        kind: todoListKind,
        title: "Todos",
        placement: "main",
        model: this.model.view,
      }),
    );
    // Calls back immediately: the first pass is the initial load. The pass starts in a
    // microtask because it drains — writes to — the model, and MODELS.md §4 point 5
    // forbids writing to a model from inside its own listener.
    register(this.model.control.onIntentUpdate(() => queueMicrotask(() => void this._reconcile())));
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    const [, cleanup] = this._registry;
    await cleanup();
  }

  private async _reconcile(): Promise<void> {
    if (this._disposed) return;
    if (this._reconciling) {
      this._rerun = true;
      return;
    }
    this._reconciling = true;
    let failure: string | undefined;
    let didWork = false;
    let reloadFailed = false;
    try {
      let again = true;
      while ((again || this._rerun) && !this._disposed) {
        again = false;
        this._rerun = false;
        const control = this.model.control;

        for (const count of control.takeSampleRequests()) this._startSample(count);

        const adds = control.takePending();
        const toggles = control.takeToggles();
        const removals = control.takeRemovals();
        if (adds.length + toggles.length + removals.length > 0) {
          didWork = true;
          // Toggles that land earlier in this same pass must be visible to a removal
          // later in the same pass — the model isn't reloaded until the pass settles,
          // so `control.getTodos()` alone would still read the pre-toggle `done`.
          const toggledThisPass = new Map<string, boolean>();
          for (const { title } of adds) {
            const f = await this._add(title);
            failure ??= f;
          }
          for (const { id } of toggles) {
            const f = await this._toggle(id, toggledThisPass);
            failure ??= f;
          }
          for (const { id } of removals) {
            const f = await this._remove(id, toggledThisPass);
            failure ??= f;
          }
          this._loadOwed = true;
        }
        // Dispose can land inside any of the awaits above; never let a pass that
        // outlived its controller reach the reload or the dialog it might open.
        if (this._disposed) break;

        if (this._loadOwed && !reloadFailed) {
          didWork = true;
          this._loadOwed = false;
          const reloaded = await this._reload();
          if (!reloaded.ok) {
            this._loadOwed = true;
            reloadFailed = true;
            failure ??= reloaded.failure;
          }
          again = true;
        }

        const clear = await this._clearStep();
        if (clear.didWork) {
          didWork = true;
          again = true;
        }
        failure ??= clear.failure;
      }
    } catch (error) {
      failure ??= `reconcile failed: ${reason(error)}`;
      didWork = true;
    } finally {
      this._reconciling = false;
    }
    if (didWork && !this._disposed) this.model.control.reportOutcome(failure);
  }

  /** Runs after a reload, so the completed count is current. */
  private async _clearStep(): Promise<{ didWork: boolean; failure?: string }> {
    if (this._disposed) return { didWork: false };
    const control = this.model.control;
    if (this._dialog) {
      const answer = this._dialog.control.takeAnswer();
      if (answer === undefined) return { didWork: false };
      const dialog = this._dialog;
      this._dialog = undefined;
      dialog.release();
      // The answer consumes every press made while the question was open.
      this._handledClear = control.getClearCompletedCount();
      if (!answer) return { didWork: false };
      try {
        const { cleared } = await this._commands.call(todosClearCompleted, {}).promise;
        if (!this._disposed && cleared > 0) this._log.info("todos:cleared", { count: cleared });
        this._loadOwed = true;
        return { didWork: true };
      } catch (error) {
        return { didWork: true, failure: `clear completed failed: ${reason(error)}` };
      }
    }
    if (control.getClearCompletedCount() > this._handledClear) {
      const completed = control.getTodos().filter((t) => t.done).length;
      if (completed === 0) {
        this._handledClear = control.getClearCompletedCount();
        return { didWork: false };
      }
      this._openDialog(`Clear ${completed} completed todo${completed === 1 ? "" : "s"}?`);
    }
    return { didWork: false };
  }

  private _openDialog(question: string): void {
    // Belt-and-suspenders: `_clearStep` already refuses to reach here once disposed,
    // but a dialog must never be provided/registered against a torn-down registry.
    if (this._disposed) return;
    const [register] = this._registry;
    const dialog = createConfirmDialogModel(question);
    const offSlot = this._slots.provide(dialogsSlot, {
      kind: confirmDialogKind,
      model: dialog.view,
    });
    // In a microtask, as the intent listener does: the pass writes to models, and
    // MODELS.md §4 point 5 forbids that from inside a listener. The immediate
    // call on subscribe only queues a pass that finds no answer yet.
    const offAnswer = dialog.control.onAnswerUpdate(() =>
      queueMicrotask(() => void this._reconcile()),
    );
    const release = register(() => {
      offAnswer();
      offSlot();
      dialog.dispose();
    });
    this._dialog = { control: dialog.control, release };
  }

  /** Fire-and-forget: sample activity never holds the reconcile loop. */
  private _startSample(count: number): void {
    const [register] = this._registry;
    const op = createSampleOperation(`Adding ${count} sample todos`, count);
    const release = register(this._slots.provide(runningOperationsSlot, op.operation));
    void (async () => {
      try {
        for (let i = 1; i <= count && !this._disposed; i++) {
          await delay(this._options.sampleDelayMs ?? 150);
          if (this._disposed) break;
          const failure = await this._add(`Sample todo ${i}`);
          if (failure !== undefined) {
            if (!this._disposed) this.model.control.reportOutcome(failure);
            break;
          }
          op.advance();
          this._loadOwed = true;
          void this._reconcile();
        }
      } finally {
        release();
        op.dispose();
      }
    })();
  }

  private async _add(title: string): Promise<string | undefined> {
    if (this._disposed) return undefined;
    try {
      const { id } = await this._commands.call(todosAdd, { title }).promise;
      if (!this._disposed) this._log.info("todos:created", { id, title });
      return undefined;
    } catch (error) {
      return `add "${title}" failed: ${reason(error)}`;
    }
  }

  private async _toggle(
    id: string,
    toggledThisPass?: Map<string, boolean>,
  ): Promise<string | undefined> {
    if (this._disposed) return undefined;
    try {
      const { done } = await this._commands.call(todosToggle, { id }).promise;
      toggledThisPass?.set(id, done);
      if (!this._disposed) this._log.info(done ? "todos:closed" : "todos:reopened", { id });
      return undefined;
    } catch (error) {
      return `toggle "${id}" failed: ${reason(error)}`;
    }
  }

  private async _remove(
    id: string,
    toggledThisPass?: Map<string, boolean>,
  ): Promise<string | undefined> {
    if (this._disposed) return undefined;
    // A toggle earlier in THIS pass hasn't reached the model yet (the reload runs
    // once, at the end of the pass), so prefer the fresh in-pass state over the
    // still-stale `control.getTodos()` read.
    const done =
      toggledThisPass?.get(id) ??
      this.model.control.getTodos().find((t) => t.id === id)?.done ??
      false;
    try {
      const { removed } = await this._commands.call(todosRemove, { id }).promise;
      if (removed && !this._disposed) this._log.info("todos:removed", { id, done });
      return undefined;
    } catch (error) {
      return `remove "${id}" failed: ${reason(error)}`;
    }
  }

  private async _reload(): Promise<{ ok: true } | { ok: false; failure: string }> {
    this.debug.reloads++;
    try {
      const todos = await this._api.list();
      if (!this._disposed) this.model.control.replaceTodos(todos);
      return { ok: true };
    } catch (error) {
      return { ok: false, failure: `reload failed: ${reason(error)}` };
    }
  }
}
