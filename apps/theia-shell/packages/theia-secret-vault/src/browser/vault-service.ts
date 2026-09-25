import type { FilesApi } from "@statewalker/webrun-files";
import { Emitter, type Event } from "@theia/core/lib/common/event";
import { inject, injectable } from "@theia/core/shared/inversify";
import { SecretVault, WrongPasswordError } from "../common/secret-vault";
import { IdbStore } from "./idb-store";

/** Where the vault lives; the app rebinds it to its main storage's `/.shell`. */
export const VaultLocation = Symbol("VaultLocation");
export type VaultLocation = () => Promise<{ files: FilesApi; dir: string; persistent: boolean }>;

export type SilentUnlock = "unlocked" | "needs-password" | "needs-new-password";

@injectable()
export class VaultService {
  @inject(VaultLocation) protected readonly location!: VaultLocation;

  /** Remembered password keys (non-extractable CryptoKeys), by vault id. */
  protected readonly remembered = new IdbStore<CryptoKey>("theia-shell-vault-keys");
  protected vaultPromise: Promise<SecretVault> | undefined;
  protected persistent = true;
  current: SecretVault | undefined;

  protected readonly unlockEmitter = new Emitter<void>();
  readonly onDidUnlock: Event<void> = this.unlockEmitter.event;

  vault(): Promise<SecretVault> {
    this.vaultPromise ??= this.location().then(({ files, dir, persistent }) => {
      const vault = new SecretVault(files, dir);
      vault.onDidChangeLock((unlocked) => unlocked && this.unlockEmitter.fire());
      this.current = vault;
      this.persistent = persistent;
      return vault;
    });
    return this.vaultPromise;
  }

  /** Unlocks without asking when it can: a session vault, or a remembered key. */
  async unlockSilently(): Promise<SilentUnlock> {
    const vault = await this.vault();
    if (vault.unlocked) return "unlocked";
    if (!this.persistent) {
      await vault.openSession();
      return "unlocked";
    }
    const id = await vault.id();
    if (!id) return "needs-new-password";
    const key = await this.remembered.get(id);
    if (key) {
      try {
        await vault.unlockWithKey(key);
        return "unlocked";
      } catch (error) {
        if (!(error instanceof WrongPasswordError)) throw error;
        await this.remembered.delete(id);
      }
    }
    return "needs-password";
  }

  async remember(passwordKey: CryptoKey): Promise<void> {
    const id = await (await this.vault()).id();
    if (id) await this.remembered.set(id, passwordKey);
  }

  async forget(): Promise<void> {
    const id = await (await this.vault()).id();
    if (id) await this.remembered.delete(id);
  }
}
