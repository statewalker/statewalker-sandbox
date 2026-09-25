import { CommonMenus } from "@theia/core/lib/browser/common-menus";
import type {
  KeybindingContext,
  KeybindingContribution,
  KeybindingRegistry,
} from "@theia/core/lib/browser/keybinding";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import type {
  TabBarToolbarContribution,
  TabBarToolbarRegistry,
} from "@theia/core/lib/browser/shell/tab-bar-toolbar";
import type { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import type { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import { inject, injectable } from "@theia/core/shared/inversify";
import { ImageViewerWidget } from "./image-viewer-widget";

const category = "Image";

export namespace ImageViewerCommands {
  export const ZOOM_IN: Command = {
    id: "imageViewer.zoomIn",
    category,
    label: "Zoom In",
    iconClass: "codicon codicon-zoom-in",
  };
  export const ZOOM_OUT: Command = {
    id: "imageViewer.zoomOut",
    category,
    label: "Zoom Out",
    iconClass: "codicon codicon-zoom-out",
  };
  export const ACTUAL_SIZE: Command = {
    id: "imageViewer.actualSize",
    category,
    label: "Actual Size",
    iconClass: "codicon codicon-screen-normal",
  };
  export const FIT: Command = {
    id: "imageViewer.fit",
    category,
    label: "Fit to Window",
    iconClass: "codicon codicon-screen-full",
  };
}

/** Keybindings apply while an image viewer is the active widget. */
@injectable()
export class ImageViewerFocusContext implements KeybindingContext {
  static readonly ID = "imageViewerFocus";
  readonly id = ImageViewerFocusContext.ID;

  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;

  isEnabled(): boolean {
    return this.shell.activeWidget instanceof ImageViewerWidget;
  }
}

@injectable()
export class ImageViewerContribution
  implements
    CommandContribution,
    KeybindingContribution,
    TabBarToolbarContribution,
    MenuContribution
{
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;

  /** The viewer a command acts on: the one whose toolbar was clicked, else the current one. */
  protected viewer(arg?: unknown): ImageViewerWidget | undefined {
    if (arg instanceof ImageViewerWidget) return arg;
    const current = this.shell.currentWidget;
    return current instanceof ImageViewerWidget ? current : undefined;
  }

  registerCommands(commands: CommandRegistry): void {
    const bind = (command: Command, run: (viewer: ImageViewerWidget) => void) =>
      commands.registerCommand(command, {
        execute: (arg?: unknown) => {
          const viewer = this.viewer(arg);
          if (viewer) run(viewer);
        },
        isEnabled: (arg?: unknown) => !!this.viewer(arg),
        isVisible: (arg?: unknown) => !!this.viewer(arg),
      });
    bind(ImageViewerCommands.ZOOM_IN, (v) => v.zoomIn());
    bind(ImageViewerCommands.ZOOM_OUT, (v) => v.zoomOut());
    bind(ImageViewerCommands.ACTUAL_SIZE, (v) => v.setZoom(1));
    bind(ImageViewerCommands.FIT, (v) => v.setZoom("fit"));
  }

  registerKeybindings(keybindings: KeybindingRegistry): void {
    const bindings: [Command, string][] = [
      [ImageViewerCommands.ZOOM_IN, "="],
      [ImageViewerCommands.ZOOM_IN, "shift+="],
      [ImageViewerCommands.ZOOM_OUT, "-"],
      [ImageViewerCommands.ACTUAL_SIZE, "1"],
      [ImageViewerCommands.FIT, "0"],
    ];
    for (const [command, keybinding] of bindings) {
      keybindings.registerKeybinding({
        command: command.id,
        keybinding,
        context: ImageViewerFocusContext.ID,
      });
    }
  }

  registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
    const commands = [
      ImageViewerCommands.ZOOM_OUT,
      ImageViewerCommands.ZOOM_IN,
      ImageViewerCommands.ACTUAL_SIZE,
      ImageViewerCommands.FIT,
    ];
    commands.forEach((command, i) => {
      toolbar.registerItem({
        id: command.id,
        command: command.id,
        tooltip: command.label,
        icon: command.iconClass,
        priority: i,
        isVisible: (widget) => widget instanceof ImageViewerWidget,
      });
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    // View → Image ▸ (enabled while an image is shown).
    const IMAGE_MENU = [...CommonMenus.VIEW, "z_image"];
    menus.registerSubmenu(IMAGE_MENU, "Image");
    [
      ImageViewerCommands.ZOOM_IN,
      ImageViewerCommands.ZOOM_OUT,
      ImageViewerCommands.ACTUAL_SIZE,
      ImageViewerCommands.FIT,
    ].forEach((command, i) => {
      menus.registerMenuAction(IMAGE_MENU, {
        commandId: command.id,
        label: command.label,
        order: String(i),
      });
    });
  }
}
