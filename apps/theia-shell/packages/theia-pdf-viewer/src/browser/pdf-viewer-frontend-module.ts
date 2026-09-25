import "../../src/browser/style/pdf-viewer.css";
import { OpenHandler } from "@theia/core/lib/browser/opener-service";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { ContainerModule } from "@theia/core/shared/inversify";
import { PdfViewerOpenHandler } from "./pdf-viewer-open-handler";
import { PdfViewerOptions, PdfViewerWidget } from "./pdf-viewer-widget";

export default new ContainerModule((bind) => {
  bind(PdfViewerOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(PdfViewerOpenHandler);
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: PdfViewerWidget.FACTORY_ID,
      createWidget: async (options: PdfViewerOptions) => {
        const child = container.createChild();
        child.bind(PdfViewerOptions).toConstantValue(options);
        child.bind(PdfViewerWidget).toSelf();
        const widget = child.get(PdfViewerWidget);
        await widget.initialize();
        return widget;
      },
    }))
    .inSingletonScope();
});
