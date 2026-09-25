import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileNavigatorContribution } from "@theia/navigator/lib/browser/navigator-contribution";

/**
 * On a first start (no layout to restore) the navigator adds the explorer to
 * the left panel but leaves the panel collapsed. The FilesApi tree is the
 * point of this shell, so show it.
 */
@injectable()
export class RevealExplorerContribution implements FrontendApplicationContribution {
  @inject(FileNavigatorContribution)
  protected readonly navigator!: FileNavigatorContribution;

  async initializeLayout(): Promise<void> {
    await this.navigator.openView({ reveal: true });
  }
}
