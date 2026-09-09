import { BaseClass } from "@statewalker/shared-baseclass";
import type { FileInfo } from "@statewalker/webrun-files";

/**
 * View-owned input. The view writes ONLY here. Because it has its own notify
 * channel, a controller subscribed to `input.onUpdate` cannot be woken by its
 * own writes to the outer model.
 */
export class PanelInputModel extends BaseClass {
  requestedPath = "";
  navigateCount = 0;
}

/** Controller-owned stable data. No bus, no FilesApi, no controller reference. */
export class PanelModel extends BaseClass {
  path: string;
  entries: FileInfo[] = [];
  stale = false;
  error?: string;
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
