import "../../src/browser/style/image-viewer.css";
import { KeybindingContext, KeybindingContribution } from "@theia/core/lib/browser/keybinding";
import { OpenHandler } from "@theia/core/lib/browser/opener-service";
import { TabBarToolbarContribution } from "@theia/core/lib/browser/shell/tab-bar-toolbar";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { ContainerModule } from "@theia/core/shared/inversify";
import { ImageViewerContribution, ImageViewerFocusContext } from "./image-viewer-contribution";
import { ImageViewerOpenHandler } from "./image-viewer-open-handler";
import { ImageViewerOptions, ImageViewerWidget } from "./image-viewer-widget";

export default new ContainerModule((bind) => {
  bind(ImageViewerOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(ImageViewerOpenHandler);

  bind(ImageViewerContribution).toSelf().inSingletonScope();
  for (const service of [
    CommandContribution,
    KeybindingContribution,
    TabBarToolbarContribution,
    MenuContribution,
  ]) {
    bind(service).toService(ImageViewerContribution);
  }
  bind(ImageViewerFocusContext).toSelf().inSingletonScope();
  bind(KeybindingContext).toService(ImageViewerFocusContext);

  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: ImageViewerWidget.FACTORY_ID,
      createWidget: async (options: ImageViewerOptions) => {
        const child = container.createChild();
        child.bind(ImageViewerOptions).toConstantValue(options);
        child.bind(ImageViewerWidget).toSelf();
        const widget = child.get(ImageViewerWidget);
        await widget.initialize();
        return widget;
      },
    }))
    .inSingletonScope();
});
