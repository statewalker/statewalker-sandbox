import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { ContainerModule } from "@theia/core/shared/inversify";
import { FileSystemProvider } from "@theia/filesystem/lib/common/files";
import { BrowserOnlyWorkspaceServer } from "@theia/workspace/lib/browser-only/browser-only-workspace-server";
import { WorkspaceServer } from "@theia/workspace/lib/common/workspace-protocol";
import { FilesApiFileSystemProvider } from "../common/files-api-fs-provider";
import { FilesApiSource, FilesApiWorkspaceRoot } from "../common/files-api-source";
import { FilesApiWorkspaceServer } from "./files-api-workspace-server";
import { RevealExplorerContribution } from "./reveal-explorer-contribution";

/**
 * Replaces the browser-only OPFS file system with the FilesApi bound to
 * `FilesApiSource`. `@theia/filesystem`'s frontendOnly module binds
 * `FileSystemProvider` to `OPFSFileSystemProvider` and serves it through
 * `BrowserOnlyFileSystemProviderServer`; this module loads after it (it
 * depends on `@theia/filesystem`), so rebinding `FileSystemProvider` is enough.
 */
export default new ContainerModule((bind, _unbind, isBound, rebind) => {
  // Defaults an app overrides with `rebind`: an empty in-memory tree at file:///.
  bind(FilesApiSource).toConstantValue(() => new MemFilesApi());
  bind(FilesApiWorkspaceRoot).toConstantValue("file:///");

  bind(FilesApiFileSystemProvider)
    .toDynamicValue(({ container }) => {
      const source = container.get<FilesApiSource>(FilesApiSource);
      return new FilesApiFileSystemProvider(() => source());
    })
    .inSingletonScope();
  if (isBound(FileSystemProvider)) {
    rebind(FileSystemProvider).toService(FilesApiFileSystemProvider);
  } else {
    bind(FileSystemProvider).toService(FilesApiFileSystemProvider);
  }

  bind(FilesApiWorkspaceServer).toSelf().inSingletonScope();
  if (isBound(WorkspaceServer)) {
    rebind(WorkspaceServer).toService(FilesApiWorkspaceServer);
  } else {
    bind(WorkspaceServer).toService(FilesApiWorkspaceServer);
  }
  // Keep the class key pointing at the same instance for anyone injecting it.
  if (isBound(BrowserOnlyWorkspaceServer)) {
    rebind(BrowserOnlyWorkspaceServer).toService(FilesApiWorkspaceServer);
  }

  bind(RevealExplorerContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(RevealExplorerContribution);
});
