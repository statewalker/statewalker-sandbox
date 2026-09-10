import type { Command, Commands } from "@statewalker/shared-commands";
import {
  uiNotify, uiShowConfirm, uiShowConflict, uiShowJob, uiShowMenu, uiShowPanel, uiShowPrompt,
} from "@fm/app";

/**
 * A rendered view. The renderer receives the model and a `settle` callback —
 * and nothing else. No bus, no controller, no FilesApi.
 */
export interface ViewHandle<M, R> {
  readonly model: M;
  settle(result: R): void;
}

export type Renderer<M, R> = (view: ViewHandle<M, R>) => (() => void) | void;

export interface Renderers {
  panel?: Renderer<never, { closed: boolean }>;
  job?: Renderer<never, unknown>;
  notify?: Renderer<never, void>;
  menu?: Renderer<never, { selectedKey?: string }>;
  confirm?: Renderer<never, { confirmed: boolean }>;
  prompt?: Renderer<never, { text: string }>;
  conflict?: Renderer<never, { resolution: "overwrite" | "skip" | "rename"; applyToAll: boolean }>;
}

export interface OpenView {
  kind: keyof Renderers;
  model: unknown;
}

/**
 * D1 — the view layer is a set of COMMAND HANDLERS.
 *
 * There is no view registry and no "mount panel" API: a controller emits
 * `ui:show-panel(model)` and this claims it, renders, and removes the view when
 * the command settles — by either side. Panels, dialogs, notifications and
 * menus are one mechanism at four different lifetimes.
 *
 * Only this file touches the bus. Components see models.
 */
export class ViewAdapter {
  private readonly _offs: (() => void)[] = [];
  private readonly _open = new Map<Command<unknown, unknown>, { kind: keyof Renderers; model: unknown; cleanup?: () => void }>();
  private _disposed = false;

  constructor(private readonly _commands: Commands, private readonly _renderers: Renderers) {
    this._bind("panel", uiShowPanel);
    this._bind("job", uiShowJob);
    this._bind("notify", uiNotify);
    this._bind("menu", uiShowMenu);
    this._bind("confirm", uiShowConfirm);
    this._bind("prompt", uiShowPrompt);
    this._bind("conflict", uiShowConflict);
  }

  openViews(): OpenView[] {
    return [...this._open.values()].map(({ kind, model }) => ({ kind, model }));
  }

  private _bind(kind: keyof Renderers, declaration: unknown): void {
    this._offs.push(
      this._commands.listen(declaration as never, ((cmd: Command<unknown, unknown>) => {
        const renderer = this._renderers[kind] as Renderer<unknown, unknown> | undefined;
        // No renderer for this kind: DON'T claim. An unhandled view kind is a
        // view-layer decision, reported to the caller as `not-claimed` rather
        // than thrown at a controller that cannot do anything about it.
        if (renderer || this._disposed) {
          if (this._disposed) return;
        } else {
          return;
        }

        const entry: { kind: keyof Renderers; model: unknown; cleanup?: () => void } = {
          kind,
          model: cmd.payload,
        };
        this._open.set(cmd, entry);
        entry.cleanup =
          renderer!({
            model: cmd.payload,
            settle: (result: unknown) => cmd.resolve(result as never),
          }) ?? undefined;

        // Removal on settle, whoever settles. This is a MICROTASK, not
        // synchronous — the bus settles through async output validation — so a
        // host writing teardown assertions must await a tick.
        cmd.promise.then(
          () => this._close(cmd),
          () => this._close(cmd),
        );
        return true;
      }) as never),
    );
  }

  private _close(cmd: Command<unknown, unknown>): void {
    const entry = this._open.get(cmd);
    if (!entry) return;
    this._open.delete(cmd);
    entry.cleanup?.();
  }

  /**
   * Every UI handler rejects its outstanding commands on dispose.
   *
   * A view that unmounts holding a claimed command would otherwise hang its
   * caller forever: the negative-priority fallback gets no second chance after
   * dispatch, so nobody else will ever answer. Cleanup runs BEFORE the
   * rejection, so "the caller heard back" implies "the view is gone".
   */
  dispose(): void {
    this._disposed = true;
    for (const off of this._offs) off();
    this._offs.length = 0;
    for (const [cmd, entry] of [...this._open]) {
      this._open.delete(cmd);
      entry.cleanup?.();
      cmd.reject(new Error(`view layer disposed while ${String(entry.kind)} was open`));
    }
  }
}
