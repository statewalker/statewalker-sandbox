import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { ContainerModule } from "@theia/core/shared/inversify";
import {
  type DeployedPlugin,
  HostedPluginServer,
} from "@theia/plugin-ext/lib/common/plugin-protocol";
import { RuntimePluginServer } from "./runtime-plugin-server";

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bind(RuntimePluginServer).toSelf().inSingletonScope();
  rebind(HostedPluginServer).toService(RuntimePluginServer);

  // Exposes `window.p6Deploy` for the e2e test; an installer UI would call
  // `RuntimePluginServer.deploy` the same way.
  bind(FrontendApplicationContribution)
    .toDynamicValue(({ container }) => ({
      onStart: () => {
        const server = container.get(RuntimePluginServer);
        (window as unknown as { p6Deploy(p: DeployedPlugin): Promise<void> }).p6Deploy = (p) =>
          server.deploy(p);
      },
    }))
    .inSingletonScope();
});
