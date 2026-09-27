import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { inject, injectable } from "@theia/core/shared/inversify";
import {
  FILE_NAVIGATOR_ID,
  type FileNavigatorWidget,
} from "@theia/navigator/lib/browser/navigator-widget";
import { MountService } from "./mount-service";

/**
 * When a filter layer changes, what every folder shows may change. Theia's
 * file tree only refreshes the parent of a changed path, and in a multi-root
 * workspace the mounts' parent is not in the tree: refresh the whole explorer.
 * Likewise when a mount's status (part of its label) changes.
 */
@injectable()
export class NavigatorRefresh implements FrontendApplicationContribution {
  @inject(MountService) protected readonly mounts!: MountService;
  @inject(WidgetManager) protected readonly widgets!: WidgetManager;

  onStart(): void {
    this.mounts.onDidChangeLayers(() => this.refresh());
    // A mount's status is part of its root's label ("Cloud (locked)"); root
    // nodes are not re-rendered on a label change alone.
    this.mounts.onDidChangeStatus(() => this.refresh());
  }

  protected async refresh(): Promise<void> {
    const navigator = await this.widgets.getWidget<FileNavigatorWidget>(FILE_NAVIGATOR_ID);
    await navigator?.model.refresh();
  }
}
