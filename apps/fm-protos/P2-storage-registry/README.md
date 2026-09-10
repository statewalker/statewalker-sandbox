# P2-storage-registry — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/P2-storage-registry/`._

---

<!-- source: 01-P2 rung record and code.md -->

# P2 — Storage registry · rung record

_9 September 2026 · green: 37/37 total (12 new) · mutations killed: 6/6_

## Verdict

`storageURI` identity with shared refcounted instances works exactly as file 04
describes, and nothing in it needed reversing. Promotion grade: **Adopt**.

## Acceptance criteria, as tested

1. At most one instance per `storageURI`, whoever asks — two panels and a job
   receive the identical object, one construction.
2. **Four panels on one remote backend authenticate once.** This is the whole
   argument against per-consumer instances, and it is now a test.
3. Disposal only when the **last** holder releases: two panels release, the job
   still holds it, the instance stays live.
4. Re-acquiring after a full release constructs a fresh instance (no zombie).
5. Release by an unknown holder is a no-op, never a decrement — the bug that
   would silently dispose an instance somebody still holds.
6. Credential references resolve by key, and **the config object is never
   written back to**: the secret value appears nowhere in it afterwards.
7. A missing credential registers the storage as `failed` with a reportable
   reason, rather than throwing at construction.
8. A failed storage does not take the others down — `mem://left` still
   acquires and reports `ready`.
9. Capabilities are read from configuration and **nothing is constructed** to
   find them out. Probing is not merely avoided, it is untestable here because
   there is no instance.
10. A pseudo-storage (`zip://out`) declares `read: false, list: false,
    write: true` without being considered broken.
11. Degradation is per storage: `s3://bucket` declares `mtime: false` and loses
    the date sort while keeping name and size.
12. The job queue's serialisation key is the `storageURI` itself — the handle
    carries it, so P6 needs no second identity.

## Note for P6 and P14

Two behaviours here are load-bearing later and should not be "simplified":

- **Re-acquire after full release constructs fresh.** A resumed job (P4) that
  re-acquires a storage gets a genuinely new instance, which is why re-acquire
  failure is a normal reportable state rather than a crash.
- **Unknown-holder release is a no-op.** Panel disposal and job completion both
  release, sometimes in either order; without this rule a double-release from
  one side disposes an instance the other side still uses.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | fresh instance on every acquire (no sharing) | 2 |
| M2 | dispose on any release (refcount ignored) | 1 |
| M3 | unknown-holder release decrements anyway | 2 |
| M4 | resolved secret written back into the config object | 1 |
| M5 | construction failure rethrown without registering `failed` | 1 |
| M6 | capabilities reported as full for everyone | 2 |

## Code

### `src/core/storage-registry.ts`

```ts
import type { FilesApi } from "@statewalker/webrun-files";

/** A reference to a variable in the secret store. Never a value. */
export interface SecretRef { $secret: string }

export interface StorageCaps {
  read: boolean; write: boolean; list: boolean;
  move: boolean; copy: boolean; remove: boolean;
  stat: { size: boolean; mtime: boolean };
}

export interface StorageConfig {
  uri: string;
  adapter: string;
  options: Record<string, unknown>;
  /** Declared by the adapter/config — never probed. Partial: unstated means available. */
  caps?: Partial<Omit<StorageCaps, "stat">> & { stat?: Partial<StorageCaps["stat"]> };
}

export interface SecretStore { get(key: string): Promise<unknown | undefined> }

export type StorageStatus = "idle" | "ready" | "failed";
export type AdapterFactory = (uri: string, options: Record<string, unknown>) => FilesApi;
export interface StorageHandle { uri: string; api: FilesApi }

const FULL: StorageCaps = {
  read: true, write: true, list: true, move: true, copy: true, remove: true,
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

  release(uri: string, holder: string): void {
    const entry = this._entries.get(uri);
    if (!entry) return;
    if (!entry.holders.delete(holder)) return; // unknown holder: no-op, not a decrement
    if (entry.holders.size === 0) {
      entry.api = undefined;
      entry.status = "idle";
    }
  }

  isLive(uri: string): boolean { return !!this._entries.get(uri)?.api; }
  status(uri: string): StorageStatus { return this._entries.get(uri)?.status ?? "idle"; }
  failure(uri: string): string | undefined { return this._entries.get(uri)?.failure; }

  /** Read from configuration only. Never constructs, never probes. */
  caps(uri: string): StorageCaps {
    const declared = this._configs.get(uri)?.caps ?? {};
    return { ...FULL, ...declared, stat: { ...FULL.stat, ...(declared.stat ?? {}) } };
  }

  /** The UI degrades per storage rather than globally. */
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
  private async _resolveOptions(options: Record<string, unknown>): Promise<Record<string, unknown>> {
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
```

Suite: `test/p2-storage-registry.test.ts`, with construction and
authentication counters per adapter factory so "one instance, one auth" is
asserted by observation rather than by identity alone.

## Still open (unchanged from file 04 §8)

Whether the secret store is consulted once at construction or on every
reconnection. The interface allows both; this prototype does the former, and
nothing here forces the choice.

