import type { FilesApi } from "@statewalker/webrun-files";

/**
 * Batch size is declared per storage and governed by the TARGET — it is the
 * side being written to. 8 is small enough that a batch boundary comes quickly
 * (cancellation feels immediate, a crash costs little) and large enough to
 * amortise remote latency. Parallelism within a batch IS the batch size; a
 * second knob would only let the two disagree.
 */
export const DEFAULTS = { batchSize: 8 } as const;

/** A reference to a variable in the secret store. Never a value. */
export interface SecretRef {
  $secret: string;
}

export interface StorageCaps {
  read: boolean;
  write: boolean;
  list: boolean;
  move: boolean;
  copy: boolean;
  remove: boolean;
  stat: { size: boolean; mtime: boolean };
}

export interface StorageConfig {
  uri: string;
  adapter: string;
  options: Record<string, unknown>;
  /** Declared by the adapter/config — never probed. Partial: unstated means available. */
  caps?: Partial<Omit<StorageCaps, "stat">> & { stat?: Partial<StorageCaps["stat"]> };
  /** Declared per storage: a rate-limited remote is not OPFS. */
  batchSize?: number;
}

export interface SecretStore {
  get(key: string): Promise<unknown | undefined>;
}

export type StorageStatus = "idle" | "ready" | "failed";
export type AdapterFactory = (uri: string, options: Record<string, unknown>) => FilesApi;
export interface StorageHandle {
  uri: string;
  api: FilesApi;
}

const FULL: StorageCaps = {
  read: true,
  write: true,
  list: true,
  move: true,
  copy: true,
  remove: true,
  stat: { size: true, mtime: true },
};

interface Entry {
  api?: FilesApi;
  holders: Set<string>;
  status: StorageStatus;
  failure?: string;
}

/**
 * P2 — `storageURI` is the identity, and instances are shared and refcounted.
 *
 * Instance identity alone would run two concurrent writes at one bucket and
 * leave each panel blind to the other's changes; per-consumer instances would
 * duplicate auth on every remote backend. Holders acquire and release
 * independently, which is what lets a job outlive the panel that started it.
 */
export class StorageRegistry {
  private readonly _configs = new Map<string, StorageConfig>();
  private readonly _entries = new Map<string, Entry>();

  constructor(
    configs: StorageConfig[],
    private readonly _factories: Record<string, AdapterFactory>,
    private readonly _secrets: SecretStore,
  ) {
    for (const config of configs) this._configs.set(config.uri, config);
  }

  async acquire(uri: string, holder: string): Promise<StorageHandle> {
    const config = this._configs.get(uri);
    if (!config) throw new Error(`Unknown storage: ${uri}`);
    let entry = this._entries.get(uri);
    if (!entry) {
      entry = { holders: new Set(), status: "idle" };
      this._entries.set(uri, entry);
    }
    if (!entry.api) {
      try {
        const options = await this._resolveOptions(config.options);
        entry.api = this._factory(config.adapter)(uri, options);
        entry.status = "ready";
        entry.failure = undefined;
      } catch (err) {
        // A failed storage is REGISTERED as failed and reportable — it does not
        // throw at construction and take every other storage down with it.
        entry.status = "failed";
        entry.failure = String((err as Error).message ?? err);
        throw new Error(`Storage ${uri} unavailable: ${entry.failure}`);
      }
    }
    entry.holders.add(holder);
    return { uri, api: entry.api };
  }

  /**
   * Pins the refcount SYNCHRONOUSLY and resolves the instance asynchronously.
   *
   * Construction is async (credential resolution), but bookkeeping must not be:
   * a caller that awaits its acquisition has a window in which another holder's
   * release can dispose the instance out from under it. `reserve` closes that
   * window, and is what lets a job be enqueued without racing the panel that
   * started it.
   */
  reserve(uri: string, holder: string): Promise<StorageHandle> {
    let entry = this._entries.get(uri);
    if (!entry) {
      entry = { holders: new Set(), status: "idle" };
      this._entries.set(uri, entry);
    }
    entry.holders.add(holder);
    return this.acquire(uri, holder).catch((err) => {
      this.release(uri, holder);
      throw err;
    });
  }

  release(uri: string, holder: string): void {
    const entry = this._entries.get(uri);
    if (!entry) return;
    if (!entry.holders.delete(holder)) return; // unknown holder: no-op, not a decrement
    if (entry.holders.size === 0) {
      entry.api = undefined;
      entry.status = "idle";
    }
  }

  isLive(uri: string): boolean {
    return !!this._entries.get(uri)?.api;
  }

  status(uri: string): StorageStatus {
    return this._entries.get(uri)?.status ?? "idle";
  }

  failure(uri: string): string | undefined {
    return this._entries.get(uri)?.failure;
  }

  /** The TARGET storage governs a job's batching: it is the side being written. */
  batchSize(uri: string): number {
    return this._configs.get(uri)?.batchSize ?? DEFAULTS.batchSize;
  }

  /** Read from configuration only. Never constructs, never probes. */
  caps(uri: string): StorageCaps {
    const declared = this._configs.get(uri)?.caps ?? {};
    return { ...FULL, ...declared, stat: { ...FULL.stat, ...(declared.stat ?? {}) } };
  }

  /** The presentation degrades per storage rather than globally. */
  sortColumns(uri: string): ("name" | "size" | "date")[] {
    const { stat } = this.caps(uri);
    const columns: ("name" | "size" | "date")[] = ["name"];
    if (stat.size) columns.push("size");
    if (stat.mtime) columns.push("date");
    return columns;
  }

  private _factory(adapter: string): AdapterFactory {
    const factory = this._factories[adapter];
    if (!factory) throw new Error(`Unknown adapter: ${adapter}`);
    return factory;
  }

  /** Credentials enter here by reference and are never written back to config. */
  private async _resolveOptions(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
      if (value && typeof value === "object" && "$secret" in (value as object)) {
        const secretKey = (value as SecretRef).$secret;
        const secret = await this._secrets.get(secretKey);
        if (secret === undefined) throw new Error(`missing credential: ${secretKey}`);
        resolved[key] = secret;
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}
