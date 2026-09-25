import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { ConfirmDialog } from "@theia/core/lib/browser/dialogs";
import type { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import type { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/common/quick-pick-service";
import { SelectionService } from "@theia/core/lib/common/selection-service";
import type URI from "@theia/core/lib/common/uri";
import { UriAwareCommandHandler } from "@theia/core/lib/common/uri-command-handler";
import { inject, injectable } from "@theia/core/shared/inversify";
import {
  NAVIGATOR_CONTEXT_MENU,
  NavigatorContextMenu,
} from "@theia/navigator/lib/browser/navigator-contribution";
import { VaultUi } from "@theia-shell/theia-secret-vault/lib/browser/vault-contribution";
import { suggestKey, validateKey } from "../common/mount-keys";
import type { MountConfig, MountType } from "../common/mount-types";
import { copySystemFolder, hasSystemFolder } from "../common/system-folder";
import { DEFAULT_MAIN, MainStorageService } from "./main-storage";
import { MountService } from "./mount-service";

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
    commands.registerCommand(MountCommands.MOUNT, { execute: () => this.wizard() });
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
      onMount((m) => this.wizard(m), notMain),
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
  }

  /** New mount, or `existing` edited (its type fixed). */
  protected async wizard(existing?: MountConfig): Promise<void> {
    const types = [...this.mounts.types().values()].filter((t) => t.isAvailable());
    const picked = existing
      ? undefined
      : await this.quick.pick(
          types.map((t) => ({ label: t.label, id: t.id })),
          { placeHolder: "Type of file system to mount" },
        );
    const type: MountType | undefined = existing
      ? this.mounts.types().get(existing.type)
      : types.find((t) => t.id === picked?.id);
    if (!type) return;
    const taken = [
      ...(this.mounts.mainKey() ? [this.mounts.mainKey() as string] : []),
      ...this.mounts
        .configuredMounts()
        .map((m) => m.key)
        .filter((k) => k !== existing?.key),
    ];
    const name = await this.quick.input({
      prompt: "Name shown in the explorer",
      value: existing?.name ?? "",
      validateInput: async (v) => (v.trim() ? undefined : "A name is required."),
    });
    if (name === undefined) return;
    const keyInput = await this.quick.input({
      prompt: "Key: the folder name at the root",
      value: existing?.key ?? suggestKey(name.trim(), taken),
      validateInput: async (v) => validateKey(v.trim(), taken),
    });
    if (keyInput === undefined) return;
    const key = keyInput.trim();
    const config: Record<string, string> = { ...(existing?.config ?? {}) };
    const secrets: Record<string, string> = {};
    for (const field of type.fields) {
      const secret = field.kind === "secret";
      const fallback =
        typeof field.default === "function" ? field.default({ key, name }) : (field.default ?? "");
      const keepSecret = secret && !!existing;
      const value = await this.quick.input({
        prompt: field.label,
        password: secret,
        value: secret ? "" : (config[field.name] ?? fallback),
        placeHolder: keepSecret ? "Leave empty to keep the current value" : undefined,
        validateInput: async (v) => {
          if (field.required && !v.trim() && !keepSecret) return `${field.label} is required.`;
          if (field.kind === "url" && v.trim() && !/^https?:\/\/[^/]/.test(v.trim()))
            return "Enter an http:// or https:// URL.";
          return undefined;
        },
      });
      if (value === undefined) return;
      if (secret) {
        if (value) secrets[field.name] = value;
      } else if (value.trim()) config[field.name] = value.trim();
      else delete config[field.name];
    }
    if (type.configure) {
      const extra = await type.configure({ key, name: name.trim(), type: type.id, config });
      if (!extra) return;
      Object.assign(config, extra);
    }
    if (type.fields.some((f) => f.kind === "secret") && !(await this.vaultUi.ensureUnlocked())) {
      this.messages.warn(
        "Secrets are locked, so the mount was not saved. Run “Secrets: Unlock” and try again.",
      );
      return;
    }
    await this.mounts.saveMount(
      { key, name: name.trim(), type: type.id, config },
      secrets,
      existing?.key,
    );
  }

  protected async unmount(mount: MountConfig): Promise<void> {
    const ok = await new ConfirmDialog({
      title: `Unmount “${mount.name}”?`,
      msg: "The files stay where they are; only the mount point is removed.",
      ok: "Unmount",
    }).open();
    if (ok) await this.mounts.unmount(mount.key);
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
