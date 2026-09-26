import { CommonMenus } from "@theia/core/lib/browser";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import type {
  TabBarToolbarContribution,
  TabBarToolbarRegistry,
} from "@theia/core/lib/browser/shell/tab-bar-toolbar";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import type { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import type { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import type URI from "@theia/core/lib/common/uri";
import { generateUuid } from "@theia/core/lib/common/uuid";
import { inject, injectable } from "@theia/core/shared/inversify";
import { Messages } from "../common/file-panels-nls";
import { type FilePanelOptions, FilePanelWidget } from "./file-panel-widget";

export namespace FilePanelsCommands {
  export const OPEN: Command = { id: "file-panels.open" };
  export const GO_UP: Command = { id: "file-panels.goUp" };
  export const REFRESH: Command = { id: "file-panels.refresh" };
}

@injectable()
export class FilePanelsContribution
  implements CommandContribution, MenuContribution, TabBarToolbarContribution
{
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
  @inject(WidgetManager) protected readonly widgets!: WidgetManager;

  get panels(): FilePanelWidget[] {
    return this.widgets.getWidgets(FilePanelWidget.FACTORY_ID) as FilePanelWidget[];
  }

  /** The panel the user is in: the current widget when it is a panel. */
  get currentPanel(): FilePanelWidget | undefined {
    const current = this.shell.currentWidget;
    return current instanceof FilePanelWidget ? current : undefined;
  }

  async openPanel(folder?: URI): Promise<FilePanelWidget> {
    const beside = this.currentPanel;
    const options: FilePanelOptions = {
      id: `file-panel:${generateUuid()}`,
      folder: folder?.toString(),
    };
    const panel = await this.widgets.getOrCreateWidget<FilePanelWidget>(
      FilePanelWidget.FACTORY_ID,
      options,
    );
    await this.shell.addWidget(
      panel,
      beside ? { area: "main", ref: beside, mode: "split-right" } : { area: "main" },
    );
    await this.shell.activateWidget(panel.id);
    return panel;
  }

  registerCommands(registry: CommandRegistry): void {
    const category = Messages.category();
    registry.registerCommand(
      { ...FilePanelsCommands.OPEN, label: Messages.openFilesPanel(), category },
      { execute: () => this.openPanel() },
    );
    registry.registerCommand(
      {
        ...FilePanelsCommands.GO_UP,
        label: Messages.goUp(),
        category,
        iconClass: "codicon codicon-arrow-up",
      },
      {
        execute: () => this.currentPanel?.goUp(),
        isEnabled: () => !!this.currentPanel?.folder && !this.currentPanel.folder.path.isRoot,
        isVisible: (widget?: unknown) => widget instanceof FilePanelWidget || !!this.currentPanel,
      },
    );
    registry.registerCommand(
      {
        ...FilePanelsCommands.REFRESH,
        label: Messages.refresh(),
        category,
        iconClass: "codicon codicon-refresh",
      },
      {
        execute: () => this.currentPanel?.refresh(),
        isEnabled: () => !!this.currentPanel,
        isVisible: (widget?: unknown) => widget instanceof FilePanelWidget || !!this.currentPanel,
      },
    );
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
      commandId: FilePanelsCommands.OPEN.id,
      label: Messages.openFilesPanel(),
    });
  }

  registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
    toolbar.registerItem({
      id: FilePanelsCommands.GO_UP.id,
      command: FilePanelsCommands.GO_UP.id,
      tooltip: Messages.goUp(),
      isVisible: (widget) => widget instanceof FilePanelWidget,
    });
    toolbar.registerItem({
      id: FilePanelsCommands.REFRESH.id,
      command: FilePanelsCommands.REFRESH.id,
      tooltip: Messages.refresh(),
      isVisible: (widget) => widget instanceof FilePanelWidget,
    });
  }
}
