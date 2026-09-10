import { compareEntries, narrowStats } from "@fm/core";
import type { Commands } from "@statewalker/shared-commands";
import type { FileInfo, FilesApi } from "@statewalker/webrun-files";
import type { ChangeObserver, Invalidation } from "./change-notifier.js";
import { panelsNavigate, uiShowPanel } from "./declarations.js";
import type { I18nRef } from "./i18n.js";
import type { PanelModel, PanelRow, RowMark, SortColumn } from "./panel-model.js";

export interface PanelControllerOptions {
  /**
   * The columns this storage can report, read from configuration by the
   * registry. Never probed, and never discovered by trying.
   */
  sortColumns?: SortColumn[];
  /**
   * Releases the panel's storage. Runs BEFORE `ui:show-panel` settles, so
   * "the panel is gone" implies "its storage is released" — otherwise an
   * observer that acts on completion races the cleanup.
   */
  release?: () => void;
}

/** How many entries a listing accumulates before it notifies progress. */
const NOTIFY_BATCH = 256;

/** A listing is either a move to a new path or a re-read of the current one. */
type FetchMode = "navigate" | "refresh";

export class PanelController implements ChangeObserver {
  private readonly _disposers: (() => void)[] = [];
  private _handledNavigate = 0;
  private _handledRefresh = 0;
  private _handledBack = 0;
  private _handledForward = 0;
  /** The last ACCEPTED sort; a refused one never takes effect. */
  private _sortBy: SortColumn = "name";
  private _filter = "";
  private _historyIndex = -1;
  /** Identifies the live listing. An overtaken one writes nothing at all. */
  private _generation = 0;
  private _pending: Promise<void> = Promise.resolve();

  constructor(
    readonly model: PanelModel,
    private readonly _api: FilesApi,
    private readonly _commands: Commands,
    private readonly _onReaction: () => void,
    private readonly _options: PanelControllerOptions = {},
  ) {
    if (_options.sortColumns) this.model.sortColumns = [..._options.sortColumns];
  }

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
    // Release is pushed BEFORE the view resolver, so dispose runs it first.
    if (this._options.release) this._disposers.push(this._options.release);
    // Controllers order views into existence; they never touch the DOM.
    const view = this._commands.call(uiShowPanel, this.model);
    this._disposers.push(() => view.resolve({ closed: true }));
    // The first listing is not a navigation intent — there is no counter to
    // answer — but the path the panel opens at IS where it has been, so it seeds
    // the history. Otherwise the first Back after one navigation has nowhere to
    // go and the panel cannot return to where it started.
    if (await this._fetch(this.model.path, "refresh")) this._pushHistory(this.model.path);
  }

  /**
   * Idempotent reconciliation: desired state computed from what the model
   * currently says. Never an event handler that assumes it observed each
   * individual change — `notify` is one undifferentiated pulse and several
   * writes in a tick collapse into it.
   *
   * The derive stage runs first and synchronously, because it is cheap and
   * because a tick that changes both the sort and the path must fetch with the
   * new sort already accepted.
   */
  private _reconcile(): void {
    this._onReaction();
    const input = this.model.input;

    if (input.sortBy !== this._sortBy || input.filterDraft !== this._filter) {
      this._applyDerive(input.sortBy, input.filterDraft);
    }

    if (input.navigateCount > this._handledNavigate) {
      this._handledNavigate = input.navigateCount;
      this._track(this._goTo(input.requestedPath, input.navigateCount));
      return;
    }
    if (input.backCount > this._handledBack) {
      this._handledBack = input.backCount;
      this._track(this._step(-1));
      return;
    }
    if (input.forwardCount > this._handledForward) {
      this._handledForward = input.forwardCount;
      this._track(this._step(1));
      return;
    }
    if (input.refreshCount > this._handledRefresh) {
      this._handledRefresh = input.refreshCount;
      this._track(this.refresh());
    }
  }

  /** Navigation by path. Records an outcome against the intent's own counter. */
  async navigate(path: string): Promise<void> {
    return this._goTo(path, this.model.input.navigateCount);
  }

  private async _goTo(path: string, seq: number): Promise<void> {
    const reached = await this._fetch(path, "navigate");
    if (reached) this._pushHistory(path);
    this.model.lastOutcome = reached
      ? { seq, status: "accepted" }
      : { seq, status: "failed", reason: this.model.error };
    this.model.notify();
  }

  /** Back and forward replay history without extending it. */
  private async _step(delta: number): Promise<void> {
    const next = this._historyIndex + delta;
    if (next < 0 || next >= this.model.history.length) return;
    const path = this.model.history[next];
    if (await this._fetch(path, "navigate")) {
      this._historyIndex = next;
      this._syncHistoryFlags();
      this.model.notify();
    }
  }

  async refresh(): Promise<void> {
    await this._fetch(this.model.path, "refresh");
  }

  /**
   * Materialise then show. The controller iterates `list()` into an array and
   * notifies the sorted result once, because entries arrive in backend order:
   * rendering progressively would either re-sort on every batch — cursor
   * jumping, unusable — or show unsorted content first.
   *
   * Returns whether the listing completed. The PARTIAL BUFFER IS ALWAYS
   * DISCARDED: a partial listing is indistinguishable from a complete one, so
   * "the file isn't there" becomes ambiguous and "copy everything in this
   * directory" would silently copy a subset.
   */
  private async _fetch(path: string, mode: FetchMode): Promise<boolean> {
    const generation = ++this._generation;
    const live = () => generation === this._generation;

    this.model.loading = true;
    this.model.loadedCount = 0;
    this.model.notify();

    const buffer: FileInfo[] = [];
    try {
      for await (const entry of this._api.list(path)) {
        // A listing for a path the panel has left is worthless: reads abort and
        // restart, and an overtaken read must not write anything at all.
        if (!live()) return false;
        buffer.push(entry);
        this.model.loadedCount = buffer.length;
        if (buffer.length % NOTIFY_BATCH === 0) this.model.notify();
      }
    } catch (err) {
      if (!live()) return false;
      this._fail(path, mode, err);
      return false;
    }
    if (!live()) return false;

    const missing = buffer.length === 0 && !(await this._api.stats(path));
    if (!live()) return false;

    this.model.path = path;
    this.model.entries = buffer;
    this.model.loadedCount = buffer.length;
    this.model.stale = false;
    this.model.lastListedAt = Date.now();
    // `list()` returns an empty iterable for a non-existent path rather than
    // throwing, so an empty result is disambiguated with `stats()`.
    this.model.error = missing ? { key: "fm.listing.missing", params: { path } } : undefined;
    this.model.breadcrumbs = breadcrumbs(path);
    // The listing is what settles the truth, so the job decorations go with it.
    if (Object.keys(this.model.marks).length > 0) this.model.marks = {};
    this._derive();
    this.model.loading = false;
    this.model.notify();
    return true;
  }

  private _fail(path: string, mode: FetchMode, err: unknown): void {
    const error: I18nRef = {
      key: "fm.listing.failed",
      params: { path, reason: String((err as Error)?.message ?? err) },
    };
    this.model.error = error;
    if (mode === "refresh") {
      // The content was true recently; the cursor and selection stay meaningful
      // and retry is one keystroke.
      this.model.stale = true;
    } else {
      // No prior listing exists for the new path, and showing the old directory
      // under a new breadcrumb is a lie. `path` is left where it was.
      this.model.entries = [];
      this.model.rows = [];
      this.model.stale = false;
    }
    this.model.loading = false;
    this.model.notify();
  }

  /**
   * The derive stage, keyed on `(entries, sortBy, filterDraft)`. It is not
   * abortable and it never touches the storage, so re-sorting a loaded 100k
   * listing costs no I/O while re-navigating does.
   */
  private _applyDerive(sortBy: SortColumn, filter: string): void {
    // Coherent means wholesale: the whole errors object is rewritten per pass,
    // so a field that just became valid cannot leave a stale message behind.
    const errors: Record<string, I18nRef> = {};
    if (this.model.sortColumns.includes(sortBy)) {
      this._sortBy = sortBy;
    } else {
      errors.sortBy = { key: "fm.sort.unavailable", params: { column: sortBy } };
    }
    this._filter = filter;
    this.model.errors = errors;
    this._derive();
    this.model.notify();
  }

  private _derive(): void {
    const needle = this._filter.trim().toLowerCase();
    const rows: PanelRow[] = [];
    for (const entry of this.model.entries) {
      if (needle && !entry.name.toLowerCase().includes(needle)) continue;
      rows.push({ name: entry.name, path: entry.path, stats: narrowStats(entry) });
    }
    rows.sort(compareEntries(this._sortBy));
    this.model.rows = rows; // replaced, never mutated in place
  }

  private _pushHistory(path: string): void {
    // A new navigation after going back truncates the forward history.
    const kept = this.model.history.slice(0, this._historyIndex + 1);
    if (kept[kept.length - 1] !== path) kept.push(path);
    this.model.history = kept;
    this._historyIndex = kept.length - 1;
    this._syncHistoryFlags();
  }

  private _syncHistoryFlags(): void {
    this.model.canGoBack = this._historyIndex > 0;
    this.model.canGoForward = this._historyIndex < this.model.history.length - 1;
  }

  /** Read live by the notifier: a panel that navigates observes a different directory. */
  get storage(): string {
    return this.model.storage;
  }

  get path(): string {
    return this.model.path;
  }

  /**
   * One batch of changes that already matched this panel's storage and cwd. The
   * notifier does the prefix fan-out, so this only decides what a change MEANS:
   * mark the rows a running job is about to remove, and re-list once for the
   * whole batch.
   */
  applyChanges(changes: Invalidation[]): void {
    const known = new Set(this.model.entries.map((entry) => entry.path));
    const marks: Record<string, RowMark> = { ...this.model.marks };
    let marked = false;
    for (const change of changes) {
      // Only a job-sourced removal of a row that EXISTS: a move is the confusing
      // case, because it appears to do nothing until it finishes.
      if (change.kind !== "removed" || !change.jobId) continue;
      if (!known.has(change.path)) continue;
      marks[change.path] = { jobId: change.jobId, kind: "pending-delete" };
      marked = true;
    }
    if (marked) {
      this.model.marks = marks; // replaced, never mutated in place
      this.model.notify();
    }
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

/** Breadcrumbs are derived from the path the panel actually reached. */
function breadcrumbs(path: string): { name: string; path: string }[] {
  const crumbs = [{ name: "/", path: "/" }];
  let at = "";
  for (const segment of path.split("/").filter(Boolean)) {
    at += `/${segment}`;
    crumbs.push({ name: segment, path: at });
  }
  return crumbs;
}
