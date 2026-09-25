import type { FilesApi } from "@statewalker/webrun-files";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { injectable } from "@theia/core/shared/inversify";
import type { MountConfig, MountField, MountType } from "../../common/mount-types";

/** A folder of the browser's Origin Private File System, under `mounts/`. */
@injectable()
export class OpfsMountType implements MountType {
  readonly id = "opfs";
  readonly label = "Browser Storage (OPFS)";
  readonly fields: MountField[] = [
    {
      name: "directory",
      label: "Folder name in browser storage",
      kind: "text",
      required: true,
      default: (m) => m.key,
    },
  ];

  isAvailable(): boolean {
    return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
  }

  async create(mount: MountConfig): Promise<FilesApi> {
    const root = await navigator.storage.getDirectory();
    const mounts = await root.getDirectoryHandle("mounts", { create: true });
    const rootHandle = await mounts.getDirectoryHandle(mount.config.directory, { create: true });
    return new BrowserFilesApi({ rootHandle });
  }
}
