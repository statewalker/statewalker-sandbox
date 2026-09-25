import "../../src/browser/style/markdown.css";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { bindViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { ContainerModule } from "@theia/core/shared/inversify";
import { MarkdownContribution } from "./markdown-contribution";
import { MarkdownOutlineWidget } from "./markdown-outline-widget";
import { MarkdownPreviewOptions, MarkdownPreviewWidget } from "./markdown-preview-widget";

export default new ContainerModule((bind) => {
  bindViewContribution(bind, MarkdownContribution);
  bind(FrontendApplicationContribution).toService(MarkdownContribution);

  bind(MarkdownOutlineWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: MarkdownOutlineWidget.ID,
      createWidget: () => container.get(MarkdownOutlineWidget),
    }))
    .inSingletonScope();

  // One preview per document; the options (its URI) are what the layout
  // restorer stores, so previews come back after a reload.
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: MarkdownPreviewWidget.FACTORY_ID,
      createWidget: async (options: MarkdownPreviewOptions) => {
        const child = container.createChild();
        child.bind(MarkdownPreviewOptions).toConstantValue(options);
        child.bind(MarkdownPreviewWidget).toSelf();
        const widget = child.get(MarkdownPreviewWidget);
        await widget.initialize();
        return widget;
      },
    }))
    .inSingletonScope();
});
