import "../../src/browser/style/file-panels.css";
import { TabBarToolbarContribution } from "@theia/core/lib/browser/shell/tab-bar-toolbar";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { ContainerModule } from "@theia/core/shared/inversify";
import { createFileNavigatorContainer } from "@theia/navigator/lib/browser/navigator-container";
import { FileNavigatorWidget } from "@theia/navigator/lib/browser/navigator-widget";
import { FileDropHandler } from "./file-drop-handler";
import { createFilePanelWidget, type FilePanelOptions, FilePanelWidget } from "./file-panel-widget";
import { FilePanelsContribution } from "./file-panels-contribution";
import { PanelAwareNavigatorWidget } from "./panel-aware-navigator-widget";
import { TransferService } from "./transfer-service";

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bind(FilePanelsContribution).toSelf().inSingletonScope();
  for (const service of [CommandContribution, MenuContribution, TabBarToolbarContribution]) {
    bind(service).toService(FilePanelsContribution);
  }
  bind(TransferService).toSelf().inSingletonScope();
  bind(FileDropHandler).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: FilePanelWidget.FACTORY_ID,
      createWidget: async (options: FilePanelOptions) => {
        const widget = createFilePanelWidget(container, options);
        await widget.initialize();
        return widget;
      },
    }))
    .inSingletonScope();

  // The explorer accepts drags from file panels (Ctrl/⌥ copies, otherwise moves, no dialog); every
  // other drop is untouched. Rebound inside a child of Theia's own navigator container so the
  // tree, model, decorators and props all stay Theia's — only the widget class changes.
  rebind(FileNavigatorWidget).toDynamicValue(({ container }) => {
    const child = createFileNavigatorContainer(container);
    child.rebind(FileNavigatorWidget).to(PanelAwareNavigatorWidget).inSingletonScope();
    return child.get(FileNavigatorWidget);
  });
});
