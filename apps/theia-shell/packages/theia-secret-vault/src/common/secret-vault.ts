import { type FilesApi, joinPath, tryReadText, writeText } from "@statewalker/webrun-files";
import { Emitter, type Event } from "@theia/core/lib/common/event";
import { fromBase64, randomBytes, toBase64, utf8 } from "./bytes";

export const VAULT_KEY_FILE = "vault.key.json";
export const SECRETS_FILE = "secrets.json";
export const DEFAULT_ITERATIONS = 600_000;

export class WrongPasswordError extends Error {
  constructor() {
    super("Wrong password");
    this.name = "WrongPasswordError";
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super("Secrets are locked");
    this.name = "VaultLockedError";
  }
}

export class VaultCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultCorruptError";
  }
}

interface VaultKeyFile {
  version: 1;
  id: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  wrap: { name: "AES-GCM"; iv: string };
  wrappedKey: string;
}

interface SecretsFile {
  version: 1;
  iv: string;
  data: string;
}

export interface SecretVaultOptions {
  /** PBKDF2 iterations for new keys; tests lower it. */
  iterations?: number;
}

/**
 * Secrets in `<dir>/secrets.json`, encrypted as a whole with a random AES-GCM
 * data key; the data key sits in `<dir>/vault.key.json`, wrapped by a key
 * derived from the user's password (PBKDF2). Unlocked, the data key is held
 * non-extractable. Writes re-read the file first, so two tabs do not erase
 * each other's secrets.
 */
export class SecretVault {
  protected dataKey: CryptoKey | undefined;
  protected passwordKey: CryptoKey | undefined;
  protected keyFile: VaultKeyFile | undefined;
  protected sessionId: string | undefined;
  protected secrets = new Map<string, string>();
  protected readonly lockEmitter = new Emitter<boolean>();
  /** Fires `true` when the vault unlocks, `false` when it locks. */
  readonly onDidChangeLock: Event<boolean> = this.lockEmitter.event;
  protected readonly iterations: number;

  constructor(
    protected readonly files: FilesApi,
    protected readonly dir: string,
    options: SecretVaultOptions = {},
  ) {
    this.iterations = options.iterations ?? DEFAULT_ITERATIONS;
  }

  get unlocked(): boolean {
    return this.dataKey !== undefined;
  }

  async id(): Promise<string | undefined> {
    return (await this.readKeyFile())?.id ?? this.sessionId;
  }

  async exists(): Promise<boolean> {
    return (await this.readKeyFile()) !== undefined;
  }

  async create(password: string): Promise<CryptoKey> {
    if (await this.exists()) throw new Error("A vault already exists here");
    return this.createVault(password);
  }

  async unlock(password: string): Promise<CryptoKey> {
    const file = await this.requireKeyFile();
    const passwordKey = await derivePasswordKey(
      password,
      fromBase64(file.kdf.salt),
      file.kdf.iterations,
    );
    await this.unlockWithKey(passwordKey);
    return passwordKey;
  }

  async unlockWithKey(passwordKey: CryptoKey): Promise<void> {
    const file = await this.requireKeyFile();
    const dataKey = await unwrapDataKey(file, passwordKey, false);
    const secrets = await this.readSecrets(dataKey, file.id);
    this.keyFile = file;
    this.passwordKey = passwordKey;
    this.dataKey = dataKey;
    this.secrets = secrets;
    this.lockEmitter.fire(true);
  }

  /** A vault for an in-memory main storage: random key, no password, nothing persisted beyond `files`. */
  async openSession(): Promise<void> {
    this.sessionId = crypto.randomUUID();
    this.dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    this.secrets = new Map();
    this.lockEmitter.fire(true);
  }

  lock(): void {
    if (!this.dataKey) return;
    this.dataKey = undefined;
    this.passwordKey = undefined;
    this.secrets = new Map();
    this.lockEmitter.fire(false);
  }

  async changePassword(newPassword: string): Promise<CryptoKey> {
    const file = this.keyFile;
    const oldKey = this.passwordKey;
    if (!file || !oldKey) throw new VaultLockedError();
    const exportable = await unwrapDataKey(file, oldKey, true);
    const { file: next, passwordKey } = await wrapDataKey(
      exportable,
      newPassword,
      file.id,
      this.iterations,
    );
    await writeText(this.files, this.path(VAULT_KEY_FILE), JSON.stringify(next, null, 2));
    this.keyFile = next;
    this.passwordKey = passwordKey;
    return passwordKey;
  }

  async reset(newPassword: string): Promise<CryptoKey> {
    await this.files.remove(this.path(VAULT_KEY_FILE));
    await this.files.remove(this.path(SECRETS_FILE));
    this.lock();
    return this.createVault(newPassword);
  }

  /** The secret, or undefined when absent or locked. */
  get(name: string): string | undefined {
    return this.secrets.get(name);
  }

  names(): string[] {
    return [...this.secrets.keys()];
  }

  async set(name: string, value: string): Promise<void> {
    await this.update((secrets) => {
      secrets.set(name, value);
      return true;
    });
  }

  async delete(name: string): Promise<boolean> {
    let removed = false;
    await this.update((secrets) => {
      removed = secrets.delete(name);
      return removed;
    });
    return removed;
  }

  protected async update(change: (secrets: Map<string, string>) => boolean): Promise<void> {
    const dataKey = this.dataKey;
    if (!dataKey) throw new VaultLockedError();
    const id = (await this.id()) as string;
    const secrets = await this.readSecrets(dataKey, id);
    if (!change(secrets)) {
      this.secrets = secrets;
      return;
    }
    await this.writeSecrets(dataKey, id, secrets);
    this.secrets = secrets;
  }

  protected async createVault(password: string): Promise<CryptoKey> {
    const id = crypto.randomUUID();
    const exportable = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const { file, passwordKey } = await wrapDataKey(exportable, password, id, this.iterations);
    await writeText(this.files, this.path(VAULT_KEY_FILE), JSON.stringify(file, null, 2));
    const dataKey = await unwrapDataKey(file, passwordKey, false);
    await this.writeSecrets(dataKey, id, new Map());
    this.keyFile = file;
    this.passwordKey = passwordKey;
    this.dataKey = dataKey;
    this.secrets = new Map();
    this.lockEmitter.fire(true);
    return passwordKey;
  }

  protected async readSecrets(dataKey: CryptoKey, id: string): Promise<Map<string, string>> {
    const text = await tryReadText(this.files, this.path(SECRETS_FILE));
    if (text === undefined) return new Map();
    try {
      const file = JSON.parse(text) as SecretsFile;
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(file.iv), additionalData: utf8(id) },
        dataKey,
        fromBase64(file.data),
      );
      return new Map(
        Object.entries(JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>),
      );
    } catch {
      throw new VaultCorruptError(`${SECRETS_FILE} cannot be decrypted with this vault's key`);
    }
  }

  protected async writeSecrets(
    dataKey: CryptoKey,
    id: string,
    secrets: Map<string, string>,
  ): Promise<void> {
    const iv = randomBytes(12);
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(id) },
      dataKey,
      utf8(JSON.stringify(Object.fromEntries(secrets))),
    );
    const file: SecretsFile = {
      version: 1,
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(data)),
    };
    await writeText(this.files, this.path(SECRETS_FILE), JSON.stringify(file));
  }

  protected async readKeyFile(): Promise<VaultKeyFile | undefined> {
    const text = await tryReadText(this.files, this.path(VAULT_KEY_FILE));
    return text === undefined ? undefined : (JSON.parse(text) as VaultKeyFile);
  }

  protected async requireKeyFile(): Promise<VaultKeyFile> {
    const file = await this.readKeyFile();
    if (!file) throw new Error("No vault here yet");
    return file;
  }

  protected path(name: string): string {
    return joinPath(this.dir, name);
  }
}

async function derivePasswordKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

async function wrapDataKey(dataKey: CryptoKey, password: string, id: string, iterations: number) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const passwordKey = await derivePasswordKey(password, salt, iterations);
  const wrapped = await crypto.subtle.wrapKey("raw", dataKey, passwordKey, {
    name: "AES-GCM",
    iv,
    additionalData: utf8(id),
  });
  const file: VaultKeyFile = {
    version: 1,
    id,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) },
    wrap: { name: "AES-GCM", iv: toBase64(iv) },
    wrappedKey: toBase64(new Uint8Array(wrapped)),
  };
  return { file, passwordKey };
}

async function unwrapDataKey(
  file: VaultKeyFile,
  passwordKey: CryptoKey,
  extractable: boolean,
): Promise<CryptoKey> {
  try {
    return await crypto.subtle.unwrapKey(
      "raw",
      fromBase64(file.wrappedKey),
      passwordKey,
      { name: "AES-GCM", iv: fromBase64(file.wrap.iv), additionalData: utf8(file.id) },
      { name: "AES-GCM", length: 256 },
      extractable,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new WrongPasswordError();
  }
}
