import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { KeyStoreService } from "@theia/core/lib/common/key-store";
import { ContainerModule, type interfaces } from "@theia/core/shared/inversify";
import { VaultKeyStore } from "../common/vault-key-store";
import { VaultUi } from "./vault-contribution";
import { VaultLocation, VaultService } from "./vault-service";
import "../../src/browser/style/vault.css";

/**
 * Browser-only Theia binds `KeyStoreService` to a stub that drops every
 * secret; this module rebinds it to the vault. It loads after @theia/core.
 */
export default new ContainerModule((bind, _unbind, isBound, rebind) => {
  bind(VaultLocation).toConstantValue(async () => ({
    files: new MemFilesApi(),
    dir: "/",
    persistent: false,
  }));
  bind(VaultService).toSelf().inSingletonScope();
  const keyStore = ({ container }: interfaces.Context) =>
    new VaultKeyStore(() => container.get<VaultService>(VaultService).current);
  if (isBound(KeyStoreService)) rebind(KeyStoreService).toDynamicValue(keyStore).inSingletonScope();
  else bind(KeyStoreService).toDynamicValue(keyStore).inSingletonScope();
  bind(VaultUi).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(VaultUi);
  bind(CommandContribution).toService(VaultUi);
});
