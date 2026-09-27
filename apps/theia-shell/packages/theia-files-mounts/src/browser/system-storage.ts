import { CompositeFilesApi } from "@statewalker/webrun-files-composite";
import type { EnvVariablesServer } from "@theia/core/lib/common/env-variables";
import { inject, injectable } from "@theia/core/shared/inversify";
import type {
  FileService,
  FileServiceContribution,
} from "@theia/filesystem/lib/browser/file-service";
import { UserStorageContribution } from "@theia/userstorage/lib/browser/user-storage-contribution";
import { FilesApiFileSystemProvider } from "@theia-shell/theia-files-api";
import { SETTINGS_FOLDER } from "../common/system-folder";
import { MainStorageService } from "./main-storage";

/** Theia's config directory (settings.json, keymaps…): the main storage's `/.shell/settings`. */
export const SHELL_SYSTEM_SCHEME = "shell-system";

@injectable()
export class ShellSystemFileServiceContribution implements FileServiceContribution {
  @inject(MainStorageService) protected readonly main!: MainStorageService;

  registerFileSystemProviders(service: FileService): void {
    service.onWillActivateFileSystemProvider((event) => {
      if (event.scheme !== SHELL_SYSTEM_SCHEME) return;
      service.registerProvider(
        SHELL_SYSTEM_SCHEME,
        new FilesApiFileSystemProvider(
          async () => new CompositeFilesApi((await this.main.open()).files, SETTINGS_FOLDER),
        ),
      );
    });
  }
}

/** User storage reads the config directory through `shell-system`, not `file` (Theia hard-codes `file`). */
@injectable()
export class ShellUserStorageContribution extends UserStorageContribution {
  protected override getDelegate(service: FileService) {
    return service.activateProvider(SHELL_SYSTEM_SCHEME);
  }
}

/** Browser-only Theia's stub, with the config directory moved. */
export const shellEnvVariablesServer: EnvVariablesServer = {
  getExecPath: async () => "",
  getVariables: async () => [],
  getValue: async () => undefined,
  getConfigDirUri: async () => `${SHELL_SYSTEM_SCHEME}:///`,
  getHomeDirUri: async () => "file:///",
  getDrives: async () => [],
};
