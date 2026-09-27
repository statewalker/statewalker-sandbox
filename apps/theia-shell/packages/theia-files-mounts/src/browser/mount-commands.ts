import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { CommonMenus } from "@theia/core/lib/browser/common-frontend-contribution";
import { ConfirmDialog } from "@theia/core/lib/browser/dialogs";
import type { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import type { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import { MessageService } from "@theia/core/lib/common/message-service";
import {
  type QuickInputButton,
  QuickInputService,
  type QuickPickItem,
  type QuickPickSeparator,
} from "@theia/core/lib/common/quick-pick-service";
import { SelectionService } from "@theia/core/lib/common/selection-service";
import type URI from "@theia/core/lib/common/uri";
import { UriAwareCommandHandler } from "@theia/core/lib/common/uri-command-handler";
import { inject, injectable } from "@theia/core/shared/inversify";
import {
  NAVIGATOR_CONTEXT_MENU,
  NavigatorContextMenu,
} from "@theia/navigator/lib/browser/navigator-contribution";
import { WorkspaceCommands } from "@theia/workspace/lib/browser/workspace-commands";
import { VaultUi } from "@theia-shell/theia-secret-vault/lib/browser/vault-contribution";
import { buildFolderList, type FolderListItem } from "../common/folder-list";
import { suggestKey } from "../common/mount-keys";
import type { MountConfig, MountType } from "../common/mount-types";
import { copySystemFolder, hasSystemFolder } from "../common/system-folder";
import { DEFAULT_MAIN, MainStorageService } from "./main-storage";
import { MountFormDialog, type MountFormResult } from "./mount-form-dialog";
import { MountService } from "./mount-service";
import type { OpfsMountType } from "./mount-types/opfs-mount-type";

interface FolderPick extends QuickPickItem {
  item: FolderListItem;
}

export namespace MountCommands {
  const category = "Files";
  export const MOUNT: Command = { id: "files.mount", category, label: "Mount File System…" };
  export const EDIT: Command = { id: "files.mount.edit", category, label: "Edit Mount…" };
  export const UNMOUNT: Command = { id: "files.unmount", category, label: "Unmount" };
  export const RECONNECT: Command = { id: "files.mount.reconnect", category, label: "Reconnect" };
  export const CHOOSE_MAIN: Command = {
    id: "files.chooseMainStorage",
    category,
    label: "Choose Main Storage…",
  };
}

@injectable()
export class MountCommandContribution implements CommandContribution, MenuContribution {
  @inject(MountService) protected readonly mounts!: MountService;
  @inject(MainStorageService) protected readonly main!: MainStorageService;
  @inject(QuickInputService) protected readonly quick!: QuickInputService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(VaultUi) protected readonly vaultUi!: VaultUi;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(MountCommands.MOUNT, { execute: () => this.folderList() });
    // Theia's workspace commands mean mounting and unmounting here.
    commands.unregisterCommand(WorkspaceCommands.ADD_FOLDER.id);
    commands.registerCommand(WorkspaceCommands.ADD_FOLDER, { execute: () => this.folderList() });
    commands.unregisterCommand(WorkspaceCommands.REMOVE_FOLDER.id);
    commands.registerCommand(
      WorkspaceCommands.REMOVE_FOLDER,
      UriAwareCommandHandler.MultiSelect(this.selection, {
        execute: (uris: URI[]) => this.removeFolders(uris),
        isVisible: (uris: URI[]) => uris.length > 0 && uris.every((u) => !!this.mounts.mountAt(u)),
      }),
    );
    const onMount = (run: (mount: MountConfig) => unknown, show: (mount: MountConfig) => boolean) =>
      UriAwareCommandHandler.MonoSelect(this.selection, {
        execute: (uri: URI) => {
          const mount = this.mounts.mountAt(uri);
          return mount && run(mount);
        },
        isVisible: (uri: URI) => {
          const mount = this.mounts.mountAt(uri);
          return !!mount && show(mount);
        },
      });
    const notMain = (m: MountConfig) => m.key !== this.mounts.mainKey();
    commands.registerCommand(
      MountCommands.EDIT,
      onMount((m) => this.editMount(m), notMain),
    );
    commands.registerCommand(
      MountCommands.UNMOUNT,
      onMount((m) => this.unmount(m), notMain),
    );
    commands.registerCommand(
      MountCommands.RECONNECT,
      onMount(
        (m) => this.mounts.reconnect(m.key),
        (m) => ["needs-access", "failed"].includes(this.mounts.status(m.key)?.state ?? ""),
      ),
    );
    commands.registerCommand(MountCommands.CHOOSE_MAIN, { execute: () => this.chooseMain() });
  }

  registerMenus(menus: MenuModelRegistry): void {
    const group = [...NAVIGATOR_CONTEXT_MENU, "7_mounts"];
    menus.registerMenuAction(group, { commandId: MountCommands.RECONNECT.id, order: "a" });
    menus.registerMenuAction(group, { commandId: MountCommands.EDIT.id, order: "b" });
    menus.registerMenuAction(group, { commandId: MountCommands.UNMOUNT.id, order: "c" });
    menus.registerMenuAction(NavigatorContextMenu.NAVIGATION, {
      commandId: MountCommands.MOUNT.id,
      order: "z",
    });
    // File menu, next to Open…: where people look for "open another place".
    menus.registerMenuAction(CommonMenus.FILE_OPEN, {
      commandId: MountCommands.MOUNT.id,
      order: "z1",
    });
    menus.registerMenuAction(CommonMenus.FILE_OPEN, {
      commandId: MountCommands.CHOOSE_MAIN.id,
      order: "z2",
    });
  }

  /** Keys a new or edited mount may not take: every other entry's (mounted or remembered) and the reserved ones. */
  protected takenKeys(except?: string): string[] {
    return [
      ...this.mounts.reservedKeys(),
      ...this.mounts
        .configuredMounts()
        .map((m) => (m as { key?: unknown } | null)?.key)
        .filter((k): k is string => typeof k === "string" && k !== except),
    ];
  }

  /** *Add Folder to Workspace…*: remembered folders, unreferenced browser-storage folders, and new ones. */
  protected async folderList(): Promise<void> {
    const opfs = [...this.mounts.types().values()].find((t) => t.id === "opfs") as
      | OpfsMountType
      | undefined;
    const directories = opfs?.isAvailable() ? await opfs.listDirectories() : [];
    const quickPick = this.quick.createQuickPick<FolderPick>();
    const forget: QuickInputButton = {
      iconClass: "codicon codicon-trash",
      tooltip: "Forget this folder",
    };
    const refresh = () => {
      const items = buildFolderList(this.mounts.validMounts(), this.mounts.types(), directories);
      const section = (
        kind: FolderListItem["kind"],
        label: string,
      ): (FolderPick | QuickPickSeparator)[] => {
        const picks = items.filter((i) => i.kind === kind).map((item) => this.toPick(item, forget));
        return picks.length ? [{ type: "separator", label }, ...picks] : [];
      };
      quickPick.items = [
        ...section("remembered", "Remembered"),
        ...section("opfs", "In browser storage"),
        ...section("new", "New"),
      ];
    };
    refresh();
    quickPick.placeholder = "Add a folder to the workspace";
    quickPick.onDidTriggerItemButton(async (event) => {
      const row = (event.item as FolderPick).item;
      if (row.kind !== "remembered") return;
      const mount = row.mount;
      quickPick.hide();
      const ok = await new ConfirmDialog({
        title: `Forget “${mount.name}”?`,
        msg: "Its settings, keys and folder access are deleted. The files themselves stay where they are.",
        ok: "Forget",
      }).open();
      if (ok) await this.mounts.forget(mount.key);
    });
    quickPick.onDidAccept(() => {
      const picked = quickPick.selectedItems[0];
      quickPick.hide();
      if (picked) void this.addFromList(picked.item);
    });
    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
  }

  protected toPick(item: FolderListItem, forget: QuickInputButton): FolderPick {
    if (item.kind === "new") return { label: item.label, item };
    return {
      label: item.label,
      description: item.description,
      item,
      buttons: item.kind === "remembered" ? [forget] : [],
    };
  }

  protected async addFromList(item: FolderListItem): Promise<void> {
    if (item.kind === "remembered") return this.mounts.remount(item.mount.key);
    if (item.kind === "opfs") {
      // One click: a browser-storage folder mounts under its own name.
      const key = suggestKey(item.directory, this.takenKeys());
      return this.mounts.saveMount(
        { key, name: item.directory, type: "opfs", config: { directory: item.directory } },
        {},
      );
    }
    return this.newMount(item.typeId);
  }

  /** A new mount: the type's interactive step first (a folder picker), then one form. */
  protected async newMount(
    typeId: string,
    preset: { name?: string; config?: Record<string, string> } = {},
  ): Promise<void> {
    const type = this.mounts.types().get(typeId);
    if (!type) return;
    let name = preset.name;
    let config = { ...(preset.config ?? {}) };
    if (type.configure) {
      const picked = await type.configure({ key: "", name: "", type: type.id, config });
      if (!picked) return;
      config = { ...config, ...picked.config };
      name = picked.name ?? name;
    }
    const result = await new MountFormDialog({
      title: type.newLabel?.replace(/…$/, "") ?? `New ${type.label}`,
      type,
      taken: this.takenKeys(),
      editing: false,
      initial: { name, config },
    }).open();
    if (result) await this.save(type, result);
  }

  /** *Edit Mount…*: the same form, prefilled; the type is fixed. */
  protected async editMount(mount: MountConfig): Promise<void> {
    const type = this.mounts.types().get(mount.type);
    if (!type) return;
    const result = await new MountFormDialog({
      title: `Edit “${mount.name}”`,
      type,
      taken: this.takenKeys(mount.key),
      editing: true,
      initial: { name: mount.name, key: mount.key, config: mount.config },
      chooseAgain: type.configure
        ? () => (type.configure as NonNullable<MountType["configure"]>)(mount)
        : undefined,
    }).open();
    if (result) await this.save(type, result, mount.key);
  }

  protected async save(
    type: MountType,
    result: MountFormResult,
    previousKey?: string,
  ): Promise<void> {
    const hasSecrets =
      Object.keys(result.secrets).length > 0 || type.fields.some((f) => f.kind === "secret");
    if (hasSecrets && !(await this.vaultUi.ensureUnlocked())) {
      this.messages.warn(
        "Secrets are locked, so the mount was not saved. Run “Secrets: Unlock” and try again.",
      );
      return;
    }
    await this.mounts.saveMount(
      { key: result.key, name: result.name, type: type.id, config: result.config },
      result.secrets,
      previousKey,
    );
  }

  protected async removeFolders(uris: URI[]): Promise<void> {
    for (const uri of uris) {
      const mount = this.mounts.mountAt(uri);
      if (!mount) continue;
      if (mount.key === this.mounts.mainKey()) {
        this.messages.warn(
          `“${mount.name}” is the main storage and cannot be removed; “Choose Main Storage…” replaces it.`,
        );
        continue;
      }
      await this.unmount(mount);
    }
  }

  /** *Remove Folder from Workspace* / *Unmount*: out of the workspace, remembered in the list. */
  protected async unmount(mount: MountConfig): Promise<void> {
    await this.mounts.unmount(mount.key);
  }

  protected async chooseMain(): Promise<void> {
    const pick = await this.quick.pick(
      [
        { label: "Browser Storage (OPFS)", id: "opfs" },
        { label: "A Folder on this Computer…", id: "local-folder" },
      ],
      { placeHolder: "Where to keep your files and settings" },
    );
    if (!pick) return;
    const current = await this.main.open();
    if (pick.id === "opfs") {
      await this.main.choose(DEFAULT_MAIN);
      window.location.reload();
      return;
    }
    const picker = (
      window as unknown as {
        showDirectoryPicker(o: { mode: "readwrite" }): Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker({ mode: "readwrite" });
    } catch {
      return;
    }
    const target = new BrowserFilesApi({ rootHandle: handle });
    if (!(await hasSystemFolder(target))) {
      const copy = await this.quick.pick(
        [
          { label: "Copy my current settings and secrets", id: "copy" },
          { label: "Start with empty settings", id: "empty" },
        ],
        { placeHolder: `“${handle.name}” has no settings yet` },
      );
      if (!copy) return;
      if (copy.id === "copy") await copySystemFolder(current.files, target);
    }
    const taken = this.mounts.configuredMounts().map((m) => m.key);
    await this.main.choose({
      type: "local-folder",
      key: suggestKey(handle.name, taken),
      name: handle.name,
      handle,
    });
    window.location.reload();
  }
}
