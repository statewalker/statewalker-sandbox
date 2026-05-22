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
 * JSON-file-backed secret store. Reads always hit disk (the file is small;
 * a stale cache is more dangerous than the extra read). Writes are
 * serialized through an internal promise chain so concurrent `set`/`delete`
 * calls don't race on the read-modify-write cycle.
 *
 * Corrupted JSON on disk is treated as an empty store; the next `set`
 * overwrites it. Boot does not fail on a malformed file.
 */
export class FilesApiSecretStore {
  private readonly files: FilesApi;
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: FilesApiSecretStoreOptions) {
    this.files = opts.systemFiles;
    this.path = opts.path ?? "/.settings/secrets.json";
  }

  private async loadFromDisk(): Promise<Record<string, string>> {
    const text = await tryReadText(this.files, this.path);
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      // Malformed JSON — treat as empty so boot survives partial writes /
      // hand-edited corruption. Next write overwrites the file.
      return {};
    }
  }

  async get(key: string): Promise<string | undefined> {
    const all = await this.loadFromDisk();
    return all[key];
  }

  async list(): Promise<string[]> {
    return Object.keys(await this.loadFromDisk());
  }

  async asEnv(prefix = ""): Promise<Record<string, string>> {
    const all = await this.loadFromDisk();
    if (!prefix) return { ...all };
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [`${prefix}${k}`, v]));
  }

  set(key: string, value: string): Promise<void> {
    return this.mutate((all) => {
      all[key] = value;
    });
  }

  delete(key: string): Promise<void> {
    return this.mutate((all) => {
      delete all[key];
    });
  }

  /**
   * Serialize read-modify-write through `writeQueue` so concurrent
   * `set`/`delete` calls compose into a deterministic final state instead
   * of last-writer-wins.
   */
  private mutate(apply: (all: Record<string, string>) => void): Promise<void> {
    const next = this.writeQueue.then(async () => {
      const all = await this.loadFromDisk();
      apply(all);
      await writeText(this.files, this.path, JSON.stringify(all));
    });
    // Swallow rejection on the chain so one failure doesn't poison subsequent
    // queued writes. Each `next` keeps its own rejection for the caller.
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}
