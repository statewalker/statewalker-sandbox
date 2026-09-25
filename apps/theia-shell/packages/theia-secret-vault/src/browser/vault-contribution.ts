import { ConfirmDialog } from "@theia/core/lib/browser/dialogs";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import type { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable } from "@theia/core/shared/inversify";
import { WrongPasswordError } from "../common/secret-vault";
import { type VaultDialogMode, VaultPasswordDialog } from "./vault-dialog";
import { VaultService } from "./vault-service";

export namespace VaultCommands {
  const category = "Secrets";
  export const UNLOCK: Command = { id: "secrets.unlock", category, label: "Unlock" };
  export const LOCK: Command = { id: "secrets.lock", category, label: "Lock" };
  export const CHANGE_PASSWORD: Command = {
    id: "secrets.changePassword",
    category,
    label: "Change Password",
  };
  export const FORGET: Command = {
    id: "secrets.forget",
    category,
    label: "Forget Remembered Password",
  };
  export const RESET: Command = { id: "secrets.reset", category, label: "Reset Vault" };
}

/** The vault's UI: the unlock-or-create prompt at start, and the commands. */
@injectable()
export class VaultUi implements FrontendApplicationContribution, CommandContribution {
  @inject(VaultService) protected readonly vaults!: VaultService;
  @inject(MessageService) protected readonly messages!: MessageService;

  onDidInitializeLayout(): void {
    void this.ensureUnlocked();
  }

  /** Unlocks, asking when it must. Resolves false if the user skipped. */
  async ensureUnlocked(): Promise<boolean> {
    const state = await this.vaults.unlockSilently();
    if (state === "unlocked") return true;
    return this.prompt(state === "needs-new-password" ? "create" : "unlock");
  }

  protected async prompt(mode: VaultDialogMode): Promise<boolean> {
    const vault = await this.vaults.vault();
    let message: string | undefined;
    for (;;) {
      const title = {
        create: "Protect your secrets",
        unlock: "Unlock secrets",
        change: "Change the secrets password",
      }[mode];
      const result = await new VaultPasswordDialog({ title, mode, message }).open();
      if (!result) return false;
      try {
        const key =
          mode === "create"
            ? await vault.create(result.password)
            : mode === "unlock"
              ? await vault.unlock(result.password)
              : await vault.changePassword(result.password);
        if (result.remember) await this.vaults.remember(key);
        return true;
      } catch (error) {
        if (error instanceof WrongPasswordError) {
          message = "Wrong password. Try again.";
          continue;
        }
        this.messages.error(`Secrets: ${(error as Error).message}`);
        return false;
      }
    }
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(VaultCommands.UNLOCK, {
      execute: () => this.ensureUnlocked(),
      isEnabled: () => !this.vaults.current?.unlocked,
    });
    commands.registerCommand(VaultCommands.LOCK, {
      execute: () => this.vaults.current?.lock(),
      isEnabled: () => !!this.vaults.current?.unlocked,
    });
    commands.registerCommand(VaultCommands.CHANGE_PASSWORD, {
      execute: () => this.prompt("change"),
      isEnabled: () => !!this.vaults.current?.unlocked,
    });
    commands.registerCommand(VaultCommands.FORGET, { execute: () => this.vaults.forget() });
    commands.registerCommand(VaultCommands.RESET, { execute: () => this.reset() });
  }

  protected async reset(): Promise<void> {
    const confirmed = await new ConfirmDialog({
      title: "Reset the secrets vault?",
      msg: "All stored secrets (S3 keys, …) are deleted and a new password is set. Files and settings are kept.",
      ok: "Reset",
    }).open();
    if (!confirmed) return;
    const result = await new VaultPasswordDialog({
      title: "New secrets password",
      mode: "create",
    }).open();
    if (!result) return;
    const key = await (await this.vaults.vault()).reset(result.password);
    if (result.remember) await this.vaults.remember(key);
  }
}
