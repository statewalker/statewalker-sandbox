import { bindViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { ContainerModule } from "@theia/core/shared/inversify";
import { P5Contribution } from "./p5-contribution";
import { P5HelloWidget } from "./p5-hello-widget";

export default new ContainerModule((bind) => {
  // bindViewContribution registers it as Command-, Menu- and KeybindingContribution.
  bindViewContribution(bind, P5Contribution);
  bind(P5HelloWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: P5HelloWidget.ID,
      createWidget: () => container.get(P5HelloWidget),
    }))
    .inSingletonScope();
});
