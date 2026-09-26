import "../../src/browser/style/file-panels.css";
import { TabBarToolbarContribution } from "@theia/core/lib/browser/shell/tab-bar-toolbar";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { ContainerModule } from "@theia/core/shared/inversify";
import { createFilePanelWidget, type FilePanelOptions, FilePanelWidget } from "./file-panel-widget";
import { FilePanelsContribution } from "./file-panels-contribution";

export default new ContainerModule((bind) => {
  bind(FilePanelsContribution).toSelf().inSingletonScope();
  for (const service of [CommandContribution, MenuContribution, TabBarToolbarContribution]) {
    bind(service).toService(FilePanelsContribution);
  }
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
});
