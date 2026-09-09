import type { Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import { panelsNavigate, uiShowPanel } from "./declarations.js";
import type { PanelModel } from "./panel-model.js";

export class PanelController {
  private readonly _disposers: (() => void)[] = [];
  private _handledNavigate = 0;
  private _pending: Promise<void> = Promise.resolve();

  constructor(
    readonly model: PanelModel,
    private readonly _api: FilesApi,
    private readonly _commands: Commands,
    private readonly _onReaction: () => void,
  ) {}

  async activate(): Promise<void> {
    // Reacting to `input` only — never to the outer model this controller writes.
    this._disposers.push(this.model.input.onUpdate(() => this._reconcile()));
    this._disposers.push(
      this._commands.listen(panelsNavigate, (cmd) => {
        // The panelId guard is the FIRST statement: a listener that throws
        // before checking would kill a command meant for another panel.
        if (cmd.payload.panelId !== this.model.id) return;
        return this.navigate(cmd.payload.path).then(() => ({ path: this.model.path }));
      }),
    );
    // Controllers order views into existence; they never touch the DOM.
    const view = this._commands.call(uiShowPanel, this.model);
    this._disposers.push(() => view.resolve({ closed: true }));
    await this.refresh();
  }

  /** Idempotent reconciliation: desired state computed from current state. */
  private _reconcile(): void {
    this._onReaction();
    if (this.model.input.navigateCount > this._handledNavigate) {
      this._handledNavigate = this.model.input.navigateCount;
      this._track(this.navigate(this.model.input.requestedPath));
    }
  }

  async navigate(path: string): Promise<void> {
    this.model.path = path;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const buffer = [];
    for await (const entry of this._api.list(this.model.path)) buffer.push(entry);
    this.model.entries = buffer; // replaced, never mutated in place
    this.model.notify();
  }

  /** Invalidation by path prefix — the ten lines that fan out over panels. */
  invalidate(storage: string, path: string): void {
    if (storage !== this.model.storage) return;
    if (!path.startsWith(this.model.path)) return;
    this._track(this.refresh());
  }

  private _track(p: Promise<void>): void {
    this._pending = this._pending.then(() => p).catch(() => undefined);
  }

  settled(): Promise<void> {
    return this._pending;
  }

  dispose(): void {
    for (const off of this._disposers) off();
    this._disposers.length = 0;
  }
}
