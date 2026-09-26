import { CommonCommands, CommonMenus } from "@theia/core/lib/browser";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import type {
  TabBarToolbarContribution,
  TabBarToolbarRegistry,
} from "@theia/core/lib/browser/shell/tab-bar-toolbar";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import type { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import type { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import { SelectionService } from "@theia/core/lib/common/selection-service";
import type URI from "@theia/core/lib/common/uri";
import { UriAwareCommandHandler } from "@theia/core/lib/common/uri-command-handler";
import { generateUuid } from "@theia/core/lib/common/uuid";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { FileStatNode } from "@theia/filesystem/lib/browser/file-tree";
import { FileNavigatorCommands } from "@theia/navigator/lib/browser/file-navigator-commands";
import { NavigatorContextMenu } from "@theia/navigator/lib/browser/navigator-contribution";
import { WorkspaceCommands } from "@theia/workspace/lib/browser/workspace-commands";
import { Messages } from "../common/file-panels-nls";
import {
  FILE_PANEL_CONTEXT_MENU,
  type FilePanelOptions,
  FilePanelWidget,
} from "./file-panel-widget";

export namespace FilePanelsCommands {
  export const OPEN: Command = { id: "file-panels.open" };
  export const GO_UP: Command = { id: "file-panels.goUp" };
  export const REFRESH: Command = { id: "file-panels.refresh" };
  export const OPEN_SELECTION: Command = { id: "file-panels.openSelection" };
  export const OPEN_AT: Command = { id: "file-panels.openAt" };
}

export namespace FilePanelMenus {
  export const OPEN = [...FILE_PANEL_CONTEXT_MENU, "1_open"];
  export const EDIT = [...FILE_PANEL_CONTEXT_MENU, "2_edit"];
  export const NEW = [...FILE_PANEL_CONTEXT_MENU, "3_new"];
  export const TRANSFER = [...FILE_PANEL_CONTEXT_MENU, "4_transfer"];
  export const PATH = [...FILE_PANEL_CONTEXT_MENU, "5_path"];
}

@injectable()
export class FilePanelsContribution
  implements CommandContribution, MenuContribution, TabBarToolbarContribution
{
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
  @inject(WidgetManager) protected readonly widgets!: WidgetManager;
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(FileService) protected readonly files!: FileService;

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
    registry.registerCommand(
      { ...FilePanelsCommands.OPEN_SELECTION, label: Messages.open() },
      {
        execute: () => {
          const panel = this.currentPanel;
          for (const node of panel?.model.selectedNodes ?? []) {
            if (FileStatNode.is(node)) panel?.model.openNode(node);
          }
        },
        isEnabled: () => !!this.currentPanel?.model.selectedNodes.length,
      },
    );
    registry.registerCommand(
      { ...FilePanelsCommands.OPEN_AT, label: Messages.openInFilesPanel(), category },
      UriAwareCommandHandler.MonoSelect(this.selection, {
        execute: async (uri) => {
          const stat = await this.files.resolve(uri);
          await this.openPanel(stat.isDirectory ? uri : uri.parent);
        },
      }),
    );
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
      commandId: FilePanelsCommands.OPEN.id,
      label: Messages.openFilesPanel(),
    });
    menus.registerMenuAction(FilePanelMenus.OPEN, {
      commandId: FilePanelsCommands.OPEN_SELECTION.id,
      order: "a",
    });
    menus.registerMenuAction(FilePanelMenus.OPEN, {
      commandId: FileNavigatorCommands.OPEN_WITH.id,
      order: "b",
    });
    menus.registerMenuAction(FilePanelMenus.EDIT, {
      commandId: WorkspaceCommands.FILE_RENAME.id,
      order: "a",
    });
    menus.registerMenuAction(FilePanelMenus.EDIT, {
      commandId: WorkspaceCommands.FILE_DUPLICATE.id,
      order: "b",
    });
    menus.registerMenuAction(FilePanelMenus.EDIT, {
      commandId: WorkspaceCommands.FILE_DELETE.id,
      order: "c",
    });
    menus.registerMenuAction(FilePanelMenus.NEW, {
      commandId: WorkspaceCommands.NEW_FILE.id,
      order: "a",
    });
    menus.registerMenuAction(FilePanelMenus.NEW, {
      commandId: WorkspaceCommands.NEW_FOLDER.id,
      order: "b",
    });
    menus.registerMenuAction(FilePanelMenus.PATH, {
      commandId: CommonCommands.COPY_PATH.id,
      order: "a",
    });
    menus.registerMenuAction(FilePanelMenus.PATH, {
      commandId: FileNavigatorCommands.REVEAL_IN_NAVIGATOR.id,
      order: "b",
    });
    menus.registerMenuAction(NavigatorContextMenu.NAVIGATION, {
      commandId: FilePanelsCommands.OPEN_AT.id,
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
