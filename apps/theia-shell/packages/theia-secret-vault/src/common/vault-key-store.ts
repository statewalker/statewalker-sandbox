import type { KeyStoreService } from "@theia/core/lib/common/key-store";
import { type SecretVault, VaultLockedError } from "./secret-vault";

/** One vault entry per (service, account); JSON keeps '/' in either unambiguous. */
export function entryName(service: string, account: string): string {
  return JSON.stringify([service, account]);
}

function parseEntryName(name: string): [string, string] | undefined {
  try {
    const parsed = JSON.parse(name);
    return Array.isArray(parsed) && parsed.length === 2 ? (parsed as [string, string]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Theia's `KeyStoreService` (behind `CredentialsService`, and VS Code
 * extensions' `context.secrets`) over the vault. Locked or absent: reads find
 * nothing, writes throw `VaultLockedError`.
 */
export class VaultKeyStore implements KeyStoreService {
  constructor(protected readonly vault: () => SecretVault | undefined) {}

  async setPassword(service: string, account: string, password: string): Promise<void> {
    await this.unlocked().set(entryName(service, account), password);
  }

  async getPassword(service: string, account: string): Promise<string | undefined> {
    return this.vault()?.get(entryName(service, account));
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const vault = this.vault();
    if (!vault?.unlocked) return false;
    return vault.delete(entryName(service, account));
  }

  async findPassword(service: string): Promise<string | undefined> {
    return (await this.findCredentials(service))[0]?.password;
  }

  async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
    const vault = this.vault();
    if (!vault?.unlocked) return [];
    const found: Array<{ account: string; password: string }> = [];
    for (const name of vault.names()) {
      const parsed = parseEntryName(name);
      if (parsed?.[0] === service)
        found.push({ account: parsed[1], password: vault.get(name) as string });
    }
    return found;
  }

  async keys(service: string): Promise<string[]> {
    return (await this.findCredentials(service)).map((c) => c.account);
  }

  protected unlocked(): SecretVault {
    const vault = this.vault();
    if (!vault?.unlocked) throw new VaultLockedError();
    return vault;
  }
}
