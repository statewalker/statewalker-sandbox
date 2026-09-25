import type {
  DidChangeLabelEvent,
  LabelProviderContribution,
} from "@theia/core/lib/browser/label-provider";
import { Emitter } from "@theia/core/lib/common/event";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import { FileStat } from "@theia/filesystem/lib/common/files";
import type { MountStatus } from "../common/mount-types";
import { MountService } from "./mount-service";

/** A root folder shows its mount's name and status: "Cloud (locked)". */
@injectable()
export class MountLabelContribution implements LabelProviderContribution {
  @inject(MountService) protected readonly mounts!: MountService;
  protected readonly changes = new Emitter<DidChangeLabelEvent>();
  readonly onDidChange = this.changes.event;

  @postConstruct()
  protected init(): void {
    this.mounts.onDidChangeStatus(() => this.changes.fire({ affects: (e) => !!this.mountOf(e) }));
  }

  canHandle(element: object): number {
    return this.mountOf(element) ? 200 : 0;
  }

  getName(element: object): string | undefined {
    const mount = this.mountOf(element);
    if (!mount) return undefined;
    return `${mount.name}${suffix(this.mounts.status(mount.key))}`;
  }

  protected mountOf(element: object) {
    const uri =
      element instanceof URI ? element : FileStat.is(element) ? element.resource : undefined;
    return uri?.scheme === "file" ? this.mounts.mountAt(uri) : undefined;
  }
}

function suffix(status: MountStatus | undefined): string {
  switch (status?.state) {
    case "failed":
      return ` (unavailable: ${status.message})`;
    case "needs-access":
      return " (click Reconnect)";
    case "locked":
      return " (locked)";
    default:
      return "";
  }
}
