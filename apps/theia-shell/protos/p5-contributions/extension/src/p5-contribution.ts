import { CommonMenus } from "@theia/core/lib/browser/common-menus";
import type { KeybindingRegistry } from "@theia/core/lib/browser/keybinding";
import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import type { Command, CommandRegistry } from "@theia/core/lib/common/command";
import type { MenuModelRegistry } from "@theia/core/lib/common/menu";
import { MessageService } from "@theia/core/lib/common/message-service";
import { SelectionService } from "@theia/core/lib/common/selection-service";
import { UriAwareCommandHandler } from "@theia/core/lib/common/uri-command-handler";
import { inject, injectable } from "@theia/core/shared/inversify";
import { NavigatorContextMenu } from "@theia/navigator/lib/browser/navigator-contribution";
import { P5HelloWidget } from "./p5-hello-widget";

export const SayHello: Command = { id: "p5.sayHello", label: "P5: Say Hello" };
export const ShowPath: Command = { id: "p5.showPath", label: "P5: Show Path" };

@injectable()
export class P5Contribution extends AbstractViewContribution<P5HelloWidget> {
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(SelectionService) protected readonly selection!: SelectionService;

  constructor() {
    super({
      widgetId: P5HelloWidget.ID,
      widgetName: P5HelloWidget.LABEL,
      defaultWidgetOptions: { area: "left", rank: 500 },
      toggleCommandId: "p5.toggleHelloView",
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(SayHello, {
      execute: () => this.messages.info("Hello from P5"),
    });
    // Enabled for a selected file: the explorer context menu passes its URI.
    commands.registerCommand(
      ShowPath,
      UriAwareCommandHandler.MonoSelect(this.selection, {
        execute: (uri) => this.messages.info(`P5 path: ${uri.path.toString()}`),
      }),
    );
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(CommonMenus.HELP, { commandId: SayHello.id, order: "z" });
    menus.registerMenuAction(NavigatorContextMenu.NAVIGATION, {
      commandId: ShowPath.id,
      order: "z",
    });
  }

  override registerKeybindings(keybindings: KeybindingRegistry): void {
    super.registerKeybindings(keybindings);
    keybindings.registerKeybinding({ command: SayHello.id, keybinding: "ctrlcmd+alt+h" });
  }
}
