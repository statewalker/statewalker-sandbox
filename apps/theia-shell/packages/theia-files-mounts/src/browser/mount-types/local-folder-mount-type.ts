import type { FilesApi } from "@statewalker/webrun-files";
import { BrowserFilesApi, isHandlerAccessible } from "@statewalker/webrun-files-browser";
import { injectable } from "@theia/core/shared/inversify";
import { IdbStore } from "@theia-shell/theia-secret-vault/lib/browser/idb-store";
import { ensureFolderAccess, type PermissionHandle } from "../../common/folder-access";
import type { MountConfig, MountContext, MountField, MountType } from "../../common/mount-types";

type Picker = (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;

/** A folder on the user's computer (File System Access API). The handle lives in IndexedDB. */
@injectable()
export class LocalFolderMountType implements MountType {
  readonly id = "local-folder";
  readonly label = "Folder on this Computer";
  readonly fields: MountField[] = [];
  protected readonly handles = new IdbStore<FileSystemDirectoryHandle>("theia-shell-handles");

  isAvailable(): boolean {
    return typeof window !== "undefined" && "showDirectoryPicker" in window;
  }

  async configure(): Promise<Record<string, string> | undefined> {
    const pick = (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await pick({ mode: "readwrite" });
    } catch {
      return undefined; // the user closed the picker
    }
    const handleId = crypto.randomUUID();
    await this.handles.set(handleId, handle);
    return { directory: handle.name, handleId };
  }

  async create(mount: MountConfig, ctx: MountContext): Promise<FilesApi> {
    const handle = await this.handles.get(mount.config.handleId);
    if (!handle)
      throw new Error("This browser no longer knows the folder; edit the mount to pick it again.");
    await ensureFolderAccess(handle as unknown as PermissionHandle, ctx.interactive, () =>
      isHandlerAccessible(handle),
    );
    return new BrowserFilesApi({ rootHandle: handle });
  }

  async forget(mount: MountConfig): Promise<void> {
    if (mount.config.handleId) await this.handles.delete(mount.config.handleId);
  }
}
