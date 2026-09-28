import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { injectable } from "@theia/core/shared/inversify";
import { ProxyWidget } from "./proxy-widget";

/** *View → Mesh Proxy* and the *Mesh: Toggle Mesh Proxy* command. */
@injectable()
export class ProxyContribution extends AbstractViewContribution<ProxyWidget> {
  constructor() {
    super({
      widgetId: ProxyWidget.ID,
      widgetName: ProxyWidget.LABEL,
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "httpeers.proxy.toggleView",
    });
  }
}
