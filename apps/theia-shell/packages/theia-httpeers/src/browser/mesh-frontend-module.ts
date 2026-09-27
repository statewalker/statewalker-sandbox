import "../../src/browser/style/mesh.css";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { bindViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { bindContributionProvider } from "@theia/core/lib/common/contribution-provider";
import { ContainerModule } from "@theia/core/shared/inversify";
import { MeshContribution } from "../common/mesh-contribution";
import { MeshContributionImpl } from "./mesh-contribution";
import { MeshService } from "./mesh-service";
import { MeshWidget } from "./mesh-widget";

export default new ContainerModule((bind) => {
  bindContributionProvider(bind, MeshContribution);
  bind(MeshService).toSelf().inSingletonScope();

  bindViewContribution(bind, MeshContributionImpl);
  bind(FrontendApplicationContribution).toService(MeshContributionImpl);
  bind(MeshWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: MeshWidget.ID,
      createWidget: () => container.get(MeshWidget),
    }))
    .inSingletonScope();
});
