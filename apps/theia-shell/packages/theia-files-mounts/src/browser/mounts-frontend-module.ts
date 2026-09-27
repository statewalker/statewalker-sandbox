import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { LabelProviderContribution } from "@theia/core/lib/browser/label-provider";
import { CommandContribution } from "@theia/core/lib/common/command";
import { bindContributionProvider } from "@theia/core/lib/common/contribution-provider";
import { EnvVariablesServer } from "@theia/core/lib/common/env-variables";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { PreferenceContribution } from "@theia/core/lib/common/preferences";
import { ContainerModule, type interfaces } from "@theia/core/shared/inversify";
import { FileService, FileServiceContribution } from "@theia/filesystem/lib/browser/file-service";
import { UserStorageContribution } from "@theia/userstorage/lib/browser/user-storage-contribution";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import {
  FilesApiChanges,
  FilesApiSource,
  FilesApiWorkspaceRoot,
} from "@theia-shell/theia-files-api";
import { VaultLocation } from "@theia-shell/theia-secret-vault/lib/browser/vault-service";
import { FilesApiLayer } from "../common/layers";
import { MountType } from "../common/mount-types";
import { SYSTEM_FOLDER } from "../common/system-folder";
import { WORKSPACE_FILE_URI } from "../common/workspace-file";
import { MainStorageService } from "./main-storage";
import { MountCommandContribution } from "./mount-commands";
import { MountLabelContribution } from "./mount-label-contribution";
import { HiddenPathsLayer, SystemFolderLayer } from "./mount-layers";
import { MountDefaults, mountPreferenceSchema } from "./mount-preferences";
import { LazyFileService, MountService } from "./mount-service";
import { LocalFolderMountType } from "./mount-types/local-folder-mount-type";
import { MemoryMountType } from "./mount-types/memory-mount-type";
import { OpfsMountType } from "./mount-types/opfs-mount-type";
import { MountsWorkspaceService, StartMounts } from "./mounts-workspace-service";
import { NavigatorRefresh } from "./navigator-refresh";
import {
  ShellSystemFileServiceContribution,
  ShellUserStorageContribution,
  shellEnvVariablesServer,
} from "./system-storage";

/**
 * The app's file system as mounts over a main storage. Loads after
 * theia-files-api, theia-secret-vault, @theia/userstorage and @theia/core (it
 * depends on them), so its rebinds win.
 */
export default new ContainerModule((bind, _unbind, isBound, rebind) => {
  bind(MainStorageService).toSelf().inSingletonScope();
  bind(MountService).toSelf().inSingletonScope();
  bind(LazyFileService).toDynamicValue(
    ({ container }) =>
      () =>
        container.get(FileService),
  );
  bind(MountDefaults).toConstantValue({ mounts: [], hidden: [] });

  bindContributionProvider(bind, MountType);
  for (const type of [MemoryMountType, OpfsMountType, LocalFolderMountType]) {
    bind(type).toSelf().inSingletonScope();
    bind(MountType).toService(type);
  }
  bindContributionProvider(bind, FilesApiLayer);
  for (const layer of [SystemFolderLayer, HiddenPathsLayer]) {
    bind(layer).toSelf().inSingletonScope();
    bind(FilesApiLayer).toService(layer);
  }

  bind(PreferenceContribution).toConstantValue({ schema: mountPreferenceSchema });

  const rebindOrBind = (id: interfaces.ServiceIdentifier<unknown>) =>
    isBound(id) ? rebind(id) : bind(id);
  rebindOrBind(FilesApiSource).toDynamicValue(
    ({ container }) =>
      () =>
        container.get(MountService).start(),
  );
  rebindOrBind(FilesApiChanges).toDynamicValue(
    ({ container }) => container.get(MountService).onDidChange,
  );
  rebindOrBind(VaultLocation).toDynamicValue(({ container }) => async () => {
    const main = await container.get(MainStorageService).open();
    return { files: main.files, dir: SYSTEM_FOLDER, persistent: main.persistent };
  });
  rebindOrBind(EnvVariablesServer).toConstantValue(shellEnvVariablesServer);
  // The mounts are the workspace's roots: a multi-root workspace file derived from them.
  bind(StartMounts).toDynamicValue(({ container }) => async () => {
    const mounts = container.get(MountService);
    await mounts.start();
    await mounts.workspaceReady();
  });
  rebind(WorkspaceService).to(MountsWorkspaceService).inSingletonScope();
  rebindOrBind(FilesApiWorkspaceRoot).toConstantValue(WORKSPACE_FILE_URI);
  rebind(UserStorageContribution).to(ShellUserStorageContribution).inSingletonScope();
  bind(ShellSystemFileServiceContribution).toSelf().inSingletonScope();
  bind(FileServiceContribution).toService(ShellSystemFileServiceContribution);

  bind(NavigatorRefresh).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(NavigatorRefresh);
  bind(MountLabelContribution).toSelf().inSingletonScope();
  bind(LabelProviderContribution).toService(MountLabelContribution);
  bind(MountCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(MountCommandContribution);
  bind(MenuContribution).toService(MountCommandContribution);
});
