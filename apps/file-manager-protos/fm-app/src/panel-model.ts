import type { Stats } from "@fm/core";
import { BaseClass } from "@statewalker/shared-baseclass";
import type { FileInfo } from "@statewalker/webrun-files";
import type { I18nRef } from "./i18n.js";

export type SortColumn = "name" | "size" | "date";

/** A listing row, narrowed through the Stats union so the size cell is a per-row fact. */
export interface PanelRow {
  name: string;
  path: string;
  stats: Stats;
}

/**
 * A per-row decoration derived from job state, keyed by path.
 *
 * v1 marks only rows that ALREADY EXIST — it synthesises none. Phantom rows for
 * files a job is about to write introduce a second source of truth in `entries`,
 * and one that never settles because a job failed is a stale lie in the listing.
 * A decoration can be wrong without corrupting anything; a row cannot.
 */
export interface RowMark {
  jobId: string;
  kind: "pending-delete";
}

export interface Breadcrumb {
  name: string;
  path: string;
}

/**
 * The answer to a view-provided intent. The controller never writes the intent
 * field back — a revert write is a lost-update race and tells the view nothing —
 * so it writes an outcome instead, and the view compares the intent's counter
 * against `seq` to know whether it is still pending. "Pending" is a derived
 * comparison rather than stored state, so it cannot go stale if a controller
 * dies mid-reaction.
 */
export interface PanelOutcome {
  seq: number;
  status: "accepted" | "declined" | "failed";
  reason?: I18nRef;
}

/**
 * View-owned input. The view writes ONLY here. Because it has its own notify
 * channel, a controller subscribed to `input.onUpdate` cannot be woken by its
 * own writes to the outer model.
 *
 * Level fields (path, sort, filter, selection) are compared by value. Edge
 * fields are **monotonic counters**, never booleans: two clicks in one tick
 * collapse a boolean flag, whereas a counter leaves a delta of 2 and both are
 * observed against the controller's watermark.
 */
export class PanelInputModel extends BaseClass {
  // level
  requestedPath = "";
  sortBy: SortColumn = "name";
  filterDraft = "";
  selection: string[] = [];
  cursor?: string;
  scrollTop = 0;
  // edge
  navigateCount = 0;
  refreshCount = 0;
  backCount = 0;
  forwardCount = 0;
}

/**
 * Controller-owned stable data. No bus, no FilesApi, no controller reference.
 *
 * One model per panel, holding its own listing — not a shared directory-model
 * registry. The panel model has to exist regardless, because it holds cwd, sort,
 * filter, selection, cursor, history, name and the storage handle; the listing is
 * one field among many, and a separate registry would mean maintaining two
 * objects and a lifetime relationship to save a duplicate `list()` that costs
 * nothing on OPFS and is rare on remote.
 */
export class PanelModel extends BaseClass {
  path: string;
  /** The materialised listing, in backend order. Replaced, never mutated. */
  entries: FileInfo[] = [];
  /** The derive stage's output: narrowed, filtered and sorted. */
  rows: PanelRow[] = [];
  breadcrumbs: Breadcrumb[] = [];
  /** Visited paths, oldest first. Only a listing that succeeded is entered. */
  history: string[] = [];
  canGoBack = false;
  canGoForward = false;
  loading = false;
  /** Entries seen so far by a listing in flight, so loading is honest. */
  loadedCount = 0;
  /**
   * Sits next to `error` so the view can dim rows and disable operations that
   * assume completeness, without the controller deciding per action.
   */
  stale = false;
  error?: I18nRef;
  /** Rows a running job is about to change, keyed by path. Cleared by a listing. */
  marks: Record<string, RowMark> = {};
  /** Per-field validation, replaced wholesale per pass so nothing goes stale. */
  errors: Record<string, I18nRef> = {};
  lastOutcome?: PanelOutcome;
  /** A "last listed" hint: the panel shows one rather than pretending to be live. */
  lastListedAt?: number;
  /** What this storage can actually sort by — declared capability, never probed. */
  sortColumns: SortColumn[] = ["name", "size", "date"];
  /** Assigned once at creation by `PanelsModel`; survivors are never renamed. */
  name = "";
  readonly input = new PanelInputModel();

  constructor(
    readonly id: string,
    /** Undefined when the layout is full: the panel floats, it is not an error. */
    readonly slot: string | undefined,
    readonly storage: string,
    path: string,
  ) {
    super();
    this.path = path;
  }
}
