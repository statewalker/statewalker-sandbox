import type { FilesApi } from "@statewalker/webrun-files";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import URI from "@theia/core/lib/common/uri";
import { ContainerModule, inject, injectable } from "@theia/core/shared/inversify";
import { FilesApiRootLabel } from "@theia-shell/theia-files-api";
import { bootGate } from "@theia-shell/theia-files-mounts/lib/browser/boot-gate";
import {
  MainStorageInitializer,
  MainStorageService,
} from "@theia-shell/theia-files-mounts/lib/browser/main-storage";
import { MountDefaults } from "@theia-shell/theia-files-mounts/lib/browser/mount-preferences";
import { MountService } from "@theia-shell/theia-files-mounts/lib/browser/mount-service";
import { MarkdownNewFileFolder } from "@theia-shell/theia-markdown/lib/browser/markdown-contribution";
import { SEED } from "./seed";
import { seedIfEmpty } from "./seed-if-empty";

/** For the e2e tests and the devtools console: the filtered root, and the boot gate. */
@injectable()
class ExposeForTests implements FrontendApplicationContribution {
  @inject(MountService) protected readonly mounts!: MountService;

  async onStart(): Promise<void> {
    const filesApi: FilesApi = await this.mounts.start();
    (window as unknown as { theiaShell: object }).theiaShell = { filesApi, bootGate };
  }
}

/**
 * The app's file system: mounts over a main storage (theia-files-mounts).
 * This module only sets the app's defaults and seeds the main storage with
 * the demo files the first time (before anything lists it).
 */
export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  rebind(MountDefaults).toConstantValue({
    mounts: [{ key: "temp", name: "Temporary", type: "memory", config: {} }],
    hidden: ["**/.git", "**/.git/**", "**/.DS_Store"],
  });
  bind(MainStorageInitializer).toConstantValue(async ({ files }: { files: FilesApi }) => {
    await seedIfEmpty(files, SEED);
  });
  rebind(FilesApiRootLabel).toConstantValue("Files");
  // The root above the mounts is read-only: new Markdown files go to the main storage.
  bind(MarkdownNewFileFolder).toDynamicValue(({ container }) => async () => {
    const main = await container.get(MainStorageService).open();
    return new URI(`file:///${main.storage.key}`);
  });
  bind(ExposeForTests).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ExposeForTests);
});
