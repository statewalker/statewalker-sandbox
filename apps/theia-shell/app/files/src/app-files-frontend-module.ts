import type { FilesApi } from "@statewalker/webrun-files";
import { getOPFSFilesApi } from "@statewalker/webrun-files-browser";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { ContainerModule } from "@theia/core/shared/inversify";
import { FilesApiRootLabel, FilesApiSource } from "@theia-shell/theia-files-api";
import { SEED } from "./seed";
import { seedIfEmpty } from "./seed-if-empty";

/**
 * The app's FilesApi. `?storage=memory` gives a fresh in-memory tree on every
 * load; otherwise the browser's Origin Private File System keeps the files
 * across reloads. Either way an empty tree is seeded with sample Markdown.
 *
 * Swapping in any other FilesApi (a local folder, HTTP, a mesh peer) is this
 * one function.
 */
async function openFilesApi(): Promise<FilesApi> {
  const storage = new URLSearchParams(location.search).get("storage");
  const files: FilesApi =
    storage === "memory" || !navigator.storage?.getDirectory
      ? new MemFilesApi()
      : await getOPFSFilesApi();
  await seedIfEmpty(files, SEED);
  // For the e2e tests and the devtools console.
  (window as unknown as { theiaShell: { filesApi: FilesApi } }).theiaShell = { filesApi: files };
  return files;
}

export default new ContainerModule((_bind, _unbind, _isBound, rebind) => {
  let files: Promise<FilesApi> | undefined;
  rebind(FilesApiSource).toConstantValue(() => {
    files ??= openFilesApi();
    return files;
  });
  rebind(FilesApiRootLabel).toConstantValue("Files");
});
