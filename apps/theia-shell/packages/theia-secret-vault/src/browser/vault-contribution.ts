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
    try {
      const state = await this.vaults.unlockSilently();
      if (state === "unlocked") return true;
      return await this.prompt(state === "needs-new-password" ? "create" : "unlock");
    } catch (error) {
      // A corrupt vault file (tampered, or from another vault): say so; nothing is overwritten.
      this.messages.error(
        `Secrets: ${(error as Error).message}. The vault stays locked; “Secrets: Reset Vault” starts a new one.`,
      );
      return false;
    }
  }

  protected async prompt(mode: VaultDialogMode): Promise<boolean> {
    const vault = await this.vaults.vault();
    const title = {
      create: "Protect your secrets",
      unlock: "Unlock secrets",
      change: "Change the secrets password",
    }[mode];
    const result = await new VaultPasswordDialog({
      title,
      mode,
      submit: (value) =>
        this.run(async () => {
          const key =
            mode === "create"
              ? await vault.create(value.password)
              : mode === "unlock"
                ? await vault.unlock(value.password)
                : await vault.changePassword(value.password);
          if (value.remember) await this.vaults.remember(key);
        }),
    }).open();
    return !!result;
  }

  /** A vault operation for a dialog's `submit`: "" when done, else the error to show in the dialog. */
  protected async run(operation: () => Promise<void>): Promise<string> {
    try {
      await operation();
      return "";
    } catch (error) {
      if (error instanceof WrongPasswordError) return "Wrong password. Try again.";
      return `Secrets: ${(error as Error).message}`;
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
    const vault = await this.vaults.vault();
    await new VaultPasswordDialog({
      title: "New secrets password",
      mode: "create",
      submit: (value) =>
        this.run(async () => {
          const key = await vault.reset(value.password);
          if (value.remember) await this.vaults.remember(key);
        }),
    }).open();
  }
}
