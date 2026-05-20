import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadText, writeText } from "@statewalker/webrun-files";

export interface FilesApiSecretStoreOptions {
  /**
   * MUST be the system view (`buildFilesViews(...).systemFiles`).
   * Passing the unfiltered `rootFiles` would expose secrets to the
   * model through `userFiles`.
   */
  systemFiles: FilesApi;
  /** Path inside `systemFiles`. Default `/.settings/secrets.json`. */
  path?: string;
}

/**
 * JSON-file-backed secret store. The cache is invalidated on every
 * `set`/`delete` (re-read on next access) so concurrent stores against
 * the same `FilesApi` stay coherent.
 */
export class FilesApiSecretStore {
  private readonly files: FilesApi;
  private readonly path: string;
  private cache?: Record<string, string>;

  constructor(opts: FilesApiSecretStoreOptions) {
    this.files = opts.systemFiles;
    this.path = opts.path ?? "/.settings/secrets.json";
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    const text = await tryReadText(this.files, this.path);
    this.cache = text ? JSON.parse(text) : {};
    // biome-ignore lint/style/noNonNullAssertion: cache just assigned above
    return this.cache!;
  }

  private async flush(): Promise<void> {
    await writeText(this.files, this.path, JSON.stringify(this.cache ?? {}));
  }

  async get(key: string): Promise<string | undefined> {
    const all = await this.load();
    return all[key];
  }

  async set(key: string, value: string): Promise<void> {
    // Re-load from disk before writing so concurrent stores see each other's writes.
    this.cache = undefined;
    const all = await this.load();
    all[key] = value;
    await this.flush();
  }

  async delete(key: string): Promise<void> {
    this.cache = undefined;
    const all = await this.load();
    delete all[key];
    await this.flush();
  }

  async list(): Promise<string[]> {
    this.cache = undefined;
    return Object.keys(await this.load());
  }

  async asEnv(prefix = ""): Promise<Record<string, string>> {
    this.cache = undefined;
    const all = await this.load();
    if (!prefix) return { ...all };
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [`${prefix}${k}`, v]));
  }
}
