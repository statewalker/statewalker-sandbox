import "../../src/browser/style/proxy.css";
import { bindViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { ContainerModule } from "@theia/core/shared/inversify";
import { MeshContribution } from "@theia-shell/theia-httpeers";
import { ProxyContribution } from "./proxy-contribution";
import { ProxyService } from "./proxy-service";
import { ProxyWidget } from "./proxy-widget";

export default new ContainerModule((bind) => {
  bind(ProxyService).toSelf().inSingletonScope();
  bind(MeshContribution).toService(ProxyService);

  bindViewContribution(bind, ProxyContribution);
  bind(ProxyWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: ProxyWidget.ID,
      createWidget: () => container.get(ProxyWidget),
    }))
    .inSingletonScope();
});
