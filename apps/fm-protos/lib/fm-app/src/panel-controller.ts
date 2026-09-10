import type { Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import { compareInfos, isUnder, narrowStats, type ChangeEvent, type ChangeNotifier } from "@fm/core";
import { panelsNavigate, uiShowPanel } from "./declarations.js";
import type { PanelModel } from "./panel-model.js";

export class PanelController {
  private readonly _disposers: (() => void)[] = [];
  private _handledNavigate = 0;
  private _handledRefresh = 0;
  private _handledBack = 0;
  private _handledForward = 0;
  private _history: string[] = [];
  private _historyAt = -1;
  private _pending: Promise<void> = Promise.resolve();

  /** Exposed for the assembly: the registry owns it, the panel borrows it. */
  get api(): FilesApi { return this._api; }

  constructor(
    readonly model: PanelModel,
    private readonly _api: FilesApi,
    private readonly _commands: Commands,
    private readonly _onReaction: () => void,
  ) {
    // The reaction to `input` is intrinsic to the controller, not to being
    // shown: a headless panel still reconciles. Only the command listeners and
    // the view request belong in activate().
    this._disposers.push(this.model.input.onUpdate(() => this._reconcile()));
    this._history = [this.model.path];
    this._historyAt = 0;
  }

  async activate(): Promise<void> {
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
    const input = this.model.input;
    // Edges first, by delta against a watermark: two presses in one tick are
    // both real, and a boolean could express only one.
    if (input.navigateCount > this._handledNavigate) {
      this._handledNavigate = input.navigateCount;
      this._track(this.navigate(input.requestedPath));
    }
    if (input.refreshCount > this._handledRefresh) {
      this._handledRefresh = input.refreshCount;
      this._track(this.refresh());
    }
    if (input.backCount > this._handledBack) {
      this._handledBack = input.backCount;
      this._track(this.back());
    }
    if (input.forwardCount > this._handledForward) {
      this._handledForward = input.forwardCount;
      this._track(this.forward());
    }
    // Levels: reconciled idempotently. No change, no work.
    if (input.sortColumn !== this._sort) this._track(this.setSort(input.sortColumn));
    if (input.filterText !== this._filter) this._track(this.setFilter(input.filterText));
  }

  private _sort: "name" | "size" | "date" = "name";
  private _filter = "";

  canGoBack(): boolean { return this._historyAt > 0; }
  canGoForward(): boolean { return this._historyAt < this._history.length - 1; }

  async back(): Promise<void> {
    if (!this.canGoBack()) return;
    this._historyAt--;
    await this._load(this._history[this._historyAt], "navigate", false);
  }

  async forward(): Promise<void> {
    if (!this.canGoForward()) return;
    this._historyAt++;
    await this._load(this._history[this._historyAt], "navigate", false);
  }

  /** Sorting and filtering are view state over ONE listing: no I/O. */
  async setSort(column: "name" | "size" | "date"): Promise<void> {
    this._sort = column;
    this._project();
  }

  async setFilter(text: string): Promise<void> {
    this._filter = text;
    this._project();
  }

  /** A stale or failed listing cannot back a "copy everything here". */
  canOperateOnListing(): boolean {
    return !this.model.stale && !this.model.error;
  }

  private _project(): void {
    const filter = this._filter.toLowerCase();
    const rows = this.model.entries.filter((e) => !filter || e.name.toLowerCase().includes(filter));
    this.model.visible = [...rows].sort(compareInfos(this._sort));
    this.model.notify();
  }

  async navigate(path: string): Promise<void> {
    await this._load(path, "navigate", true);
  }

  async refresh(): Promise<void> {
    await this._load(this.model.path, "refresh", false);
  }

  /**
   * One loader, two failure policies.
   *
   * A REFRESH that fails keeps the prior entries and marks them `stale`: the
   * content was true recently, the cursor and selection stay meaningful, and
   * retry is one keystroke. A NAVIGATION that fails clears them, because
   * showing the previous directory's contents under a new breadcrumb is a lie.
   *
   * In both cases the partial buffer is DISCARDED. A partial listing is
   * indistinguishable from a complete one, so "the file isn't there" becomes
   * ambiguous and "copy everything here" would silently copy a subset.
   */
  private async _load(path: string, mode: "navigate" | "refresh", pushHistory: boolean): Promise<void> {
    const buffer = [];
    try {
      for await (const entry of this._api.list(path)) {
        narrowStats(entry); // conformance at the boundary, per P1
        buffer.push(entry);
      }
    } catch (err) {
      const message = String((err as Error).message ?? err);
      if (mode === "refresh") {
        this.model.stale = true; // entries kept: true recently, not now
      } else {
        this.model.path = path;
        this.model.entries = [];
        this.model.stale = false;
        this._project();
      }
      this.model.error = message;
      this.model.notify();
      return;
    }

    // `list()` returns an empty iterable for a path that does not exist, so an
    // empty listing has to be disambiguated before it is reported as empty.
    this.model.missing = buffer.length === 0 ? !(await this._api.exists(path)) : false;

    if (pushHistory && path !== this.model.path) {
      this._history = [...this._history.slice(0, this._historyAt + 1), path];
      this._historyAt = this._history.length - 1;
    }
    this.model.path = path;
    this.model.entries = buffer; // replaced, never mutated in place
    this.model.stale = false;
    this.model.error = undefined;
    this.model.lastListedAt = Date.now();
    this.model.marks = {}; // the listing now reflects whatever was marked
    this._project();
    for (const listener of this._listed) listener();
  }

  /**
   * Invalidation by path prefix — the ten lines that fan out over panels.
   *
   * The notifier has already coalesced a job's entries into ONE batch, so a
   * 500-file copy costs this panel a single re-listing rather than 500.
   */
  subscribe(notifier: ChangeNotifier): void {
    this._disposers.push(notifier.onChange((batch) => this._onChanges(batch)));
  }

  /** Fired after each successful listing. Used by tests and by the view layer. */
  onListed(listener: () => void): () => void {
    this._listed.add(listener);
    return () => this._listed.delete(listener);
  }

  private readonly _listed = new Set<() => void>();

  private _onChanges(batch: ChangeEvent[]): void {
    const mine = batch.filter(
      (event) => event.storageUri === this.model.storage && isUnder(event.path, this.model.path),
    );
    if (mine.length === 0) return;

    // Mark first, re-list second: the user sees the rows in question flagged
    // immediately, and the marks clear when the listing that reflects them
    // arrives.
    const marks = { ...this.model.marks };
    for (const event of mine) marks[event.path] = { jobId: event.jobId, kind: event.kind };
    this.model.marks = marks;
    this.model.notify();

    this._track(this.refresh());
  }

  invalidate(storage: string, path: string): void {
    if (storage !== this.model.storage) return;
    if (!isUnder(path, this.model.path)) return;
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
