import { BaseClass } from "@statewalker/shared-baseclass";
import type { FileInfo } from "@statewalker/webrun-files";

/**
 * View-owned input. The view writes ONLY here. Because it has its own notify
 * channel, a controller subscribed to `input.onUpdate` cannot be woken by its
 * own writes to the outer model.
 */
export class PanelInputModel extends BaseClass {
  /** Level fields: compared by value. */
  requestedPath = "";
  sortColumn: "name" | "size" | "date" = "name";
  filterText = "";
  /** Edge fields: monotonic counters, acted on by delta against a watermark. */
  navigateCount = 0;
  refreshCount = 0;
  backCount = 0;
  forwardCount = 0;
}

/** Controller-owned stable data. No bus, no FilesApi, no controller reference. */
export class PanelModel extends BaseClass {
  path: string;
  name = "";
  /** The complete listing, as read. Never a partial buffer. */
  entries: FileInfo[] = [];
  /** entries + filter + sort. Derived, but written by the controller. */
  visible: FileInfo[] = [];
  /** True when `entries` was true recently but a refresh has since failed. */
  stale = false;
  /** True when the path itself does not exist, as opposed to being empty. */
  missing = false;
  /** 0 until the first successful listing; a failed listing never stamps it. */
  lastListedAt = 0;
  /**
   * Rows the panel knows are changing, keyed by path, with the job that is
   * changing them. Set when a change arrives, cleared by the listing that
   * reflects it — the weaker per-row marking that ships in v1, ahead of full
   * optimistic phantom rows.
   */
  marks: Record<string, { jobId?: string; kind: string }> = {};
  error?: string;
  readonly input = new PanelInputModel();

  constructor(
    readonly id: string,
    readonly slot: string | undefined,
    readonly storage: string,
    path: string,
  ) {
    super();
    this.path = path;
  }
}
