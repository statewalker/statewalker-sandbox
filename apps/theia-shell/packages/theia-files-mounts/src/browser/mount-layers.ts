import type { FilesApi } from "@statewalker/webrun-files";
import { MessageService } from "@theia/core/lib/common/message-service";
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
  @inject(MessageService) protected readonly messages!: MessageService;
  protected readonly reported = new Set<string>();

  wrap(root: FilesApi): FilesApi {
    const set: unknown = this.preferences.inspect(HIDDEN_PREFERENCE)?.globalValue;
    const globs: unknown[] = Array.isArray(set) ? set : this.defaults.hidden;
    return hiddenPathsFilter(globs, (glob) => this.warnOnce(glob))(root);
  }

  protected warnOnce(glob: unknown): void {
    const text = JSON.stringify(glob);
    if (this.reported.has(text)) return;
    this.reported.add(text);
    this.messages.warn(`files.hidden: ${text} is not a valid glob pattern; it is ignored.`);
  }
}
