import type { FilesApi } from "@statewalker/webrun-files";
import { BrowserFilesApi, isHandlerAccessible } from "@statewalker/webrun-files-browser";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { inject, injectable, optional } from "@theia/core/shared/inversify";
import { IdbStore } from "@theia-shell/theia-secret-vault/lib/browser/idb-store";
import type { PermissionHandle } from "../common/folder-access";
import { ensureSystemFolder } from "../common/system-folder";
import { bootGate } from "./boot-gate";

export type MainStorage =
  | { type: "opfs" | "memory"; key: string; name: string }
  | { type: "local-folder"; key: string; name: string; handle: FileSystemDirectoryHandle };

export const DEFAULT_MAIN: MainStorage = { type: "opfs", key: "browser", name: "Browser Storage" };

export interface OpenedMainStorage {
  storage: MainStorage;
  files: FilesApi;
  persistent: boolean;
}

/** Optional: runs once the main storage is open, before anything reads it (the app seeds it). */
export const MainStorageInitializer = Symbol("MainStorageInitializer");
export type MainStorageInitializer = (opened: OpenedMainStorage) => Promise<void>;

/**
 * The one persistent mount holding `/.shell` (settings, vault). Which storage
 * is main is kept in IndexedDB, because the settings are read from it.
 * `?storage=memory`, or no OPFS: an in-memory main, not persistent.
 */
@injectable()
export class MainStorageService {
  @inject(MainStorageInitializer)
  @optional()
  protected readonly initializer?: MainStorageInitializer;
  protected readonly store = new IdbStore<MainStorage>("theia-shell-boot");
  protected opened: Promise<OpenedMainStorage> | undefined;
  current: OpenedMainStorage | undefined;

  open(): Promise<OpenedMainStorage> {
    this.opened ??= this.doOpen().then(async (opened) => {
      await ensureSystemFolder(opened.files);
      await this.initializer?.(opened);
      this.current = opened;
      return opened;
    });
    return this.opened;
  }

  async choose(next: MainStorage): Promise<void> {
    await this.store.set("main", next);
  }

  protected async doOpen(): Promise<OpenedMainStorage> {
    const memory = new URLSearchParams(location.search).get("storage") === "memory";
    if (memory || !navigator.storage?.getDirectory) {
      return {
        storage: { ...DEFAULT_MAIN, type: "memory" },
        files: new MemFilesApi(),
        persistent: false,
      };
    }
    const saved = (await this.store.get("main")) ?? DEFAULT_MAIN;
    if (saved.type === "local-folder") {
      const handle = saved.handle as unknown as PermissionHandle;
      const granted = (await handle.queryPermission({ mode: "readwrite" })) === "granted";
      const result =
        granted && (await isHandlerAccessible(saved.handle))
          ? "opened"
          : await bootGate(
              saved.name,
              async () => (await handle.requestPermission({ mode: "readwrite" })) === "granted",
              () => isHandlerAccessible(saved.handle),
            );
      if (result === "opened")
        return {
          storage: saved,
          files: new BrowserFilesApi({ rootHandle: saved.handle }),
          persistent: true,
        };
      return this.openOpfs(DEFAULT_MAIN);
    }
    return this.openOpfs(saved);
  }

  protected async openOpfs(storage: MainStorage): Promise<OpenedMainStorage> {
    const root = await navigator.storage.getDirectory();
    const rootHandle = await root.getDirectoryHandle("main", { create: true });
    return { storage, files: new BrowserFilesApi({ rootHandle }), persistent: true };
  }
}
