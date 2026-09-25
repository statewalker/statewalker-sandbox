import type { FilesApi } from "@statewalker/webrun-files";
import { PreferenceService } from "@theia/core/lib/common/preferences";
import { inject, injectable } from "@theia/core/shared/inversify";
import { type FilesApiLayer, hiddenPathsFilter, systemFolderFilter } from "../common/layers";
import { SYSTEM_FOLDER } from "../common/system-folder";
import { MainStorageService } from "./main-storage";
import { HIDDEN_PREFERENCE, MountDefaults } from "./mount-preferences";

/** Always on: `/<main key>/.shell` is never in the file tree. */
@injectable()
export class SystemFolderLayer implements FilesApiLayer {
  readonly id = "system-folder";
  readonly priority = 0;
  @inject(MainStorageService) protected readonly main!: MainStorageService;

  wrap(root: FilesApi): FilesApi {
    const key = this.main.current?.storage.key;
    return systemFolderFilter(key ? `/${key}${SYSTEM_FOLDER}` : undefined)(root);
  }
}

/** The `files.hidden` globs (or the app's default). */
@injectable()
export class HiddenPathsLayer implements FilesApiLayer {
  readonly id = "hidden-paths";
  readonly priority = 10;
  @inject(PreferenceService) protected readonly preferences!: PreferenceService;
  @inject(MountDefaults) protected readonly defaults!: MountDefaults;

  wrap(root: FilesApi): FilesApi {
    const set = this.preferences.inspect<string[]>(HIDDEN_PREFERENCE)?.globalValue;
    return hiddenPathsFilter(Array.isArray(set) ? set : this.defaults.hidden)(root);
  }
}
