import type { FilesApi } from "@statewalker/webrun-files";
import { CompositeFilesApi, readOnly } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { FilesApiChange } from "@theia-shell/theia-files-api";
import {
  type MountConfig,
  type MountStatus,
  type MountType,
  NeedsUserGesture,
  SecretsLocked,
} from "./mount-types";

interface Entry {
  config: MountConfig;
  api: FilesApi;
  status: MountStatus;
}

export interface ApplyOptions {
  /** Mounts supplied ready-made (the main storage); always present. */
  fixed?: readonly { config: MountConfig; api: FilesApi }[];
  /** Passed to the types' `create` for mounts (re)created in this call. */
  interactive?: boolean;
  /** Re-create an unchanged mount anyway (e.g. `locked` after an unlock). */
  recreate?: (key: string, status: MountStatus) => boolean;
}

const empty = () => readOnly(new MemFilesApi());

/**
 * The set of mounted file systems and the composite that shows them as root
 * folders. `apply` brings it to a new list of configs: unchanged mounts are
 * kept, a key change with the same type and config is a rename (the same
 * FilesApi), anything else is (re)created. A mount that cannot be created is
 * an empty read-only placeholder with a status saying why.
 */
export class MountTable {
  protected entries = new Map<string, Entry>();
  protected root: FilesApi = new CompositeFilesApi(empty());

  constructor(
    protected readonly types: (id: string) => MountType | undefined,
    protected readonly secrets: (mount: MountConfig, field: string) => Promise<string | undefined>,
    protected readonly isLocked: () => boolean = () => false,
  ) {}

  composite(): FilesApi {
    return this.root;
  }

  status(key: string): MountStatus | undefined {
    return this.entries.get(key)?.status;
  }

  configs(): MountConfig[] {
    return [...this.entries.values()].map((e) => e.config);
  }

  async apply(
    configs: readonly MountConfig[],
    options: ApplyOptions = {},
  ): Promise<FilesApiChange[]> {
    const previous = this.entries;
    const next = new Map<string, Entry>();
    const claimed = new Set<Entry>();
    const newKeys = new Set([
      ...configs.map((c) => c.key),
      ...(options.fixed ?? []).map((f) => f.config.key),
    ]);

    for (const { config, api } of options.fixed ?? []) {
      const entry = { config, api, status: { state: "mounted" } as MountStatus };
      next.set(config.key, entry);
    }
    await Promise.all(
      configs.map(async (config) => {
        const same = previous.get(config.key);
        if (
          same &&
          sameMount(same.config, config) &&
          !options.recreate?.(config.key, same.status)
        ) {
          claimed.add(same);
          next.set(config.key, { ...same, config });
          return;
        }
        const renamed = [...previous.values()].find(
          (e) =>
            !claimed.has(e) &&
            !newKeys.has(e.config.key) &&
            sameMount(e.config, config) &&
            e.status.state === "mounted",
        );
        if (renamed) {
          claimed.add(renamed);
          next.set(config.key, { ...renamed, config });
          return;
        }
        next.set(config.key, await this.create(config, options.interactive ?? false));
      }),
    );

    const changes: FilesApiChange[] = [];
    for (const key of previous.keys())
      if (!next.has(key)) changes.push({ type: "deleted", path: `/${key}` });
    for (const [key, entry] of next) {
      const before = previous.get(key);
      if (!before) changes.push({ type: "added", path: `/${key}` });
      else if (before.api !== entry.api || before.status.state !== entry.status.state) {
        changes.push({ type: "updated", path: `/${key}` });
      }
    }

    // Keep the caller's order for configs; fixed mounts first.
    const ordered = new Map<string, Entry>();
    for (const { config } of options.fixed ?? [])
      ordered.set(config.key, next.get(config.key) as Entry);
    for (const config of configs) ordered.set(config.key, next.get(config.key) as Entry);
    this.entries = ordered;
    const composite = new CompositeFilesApi(empty());
    for (const [key, entry] of ordered) composite.mount(`/${key}`, entry.api);
    this.root = composite;
    return changes;
  }

  protected async create(config: MountConfig, interactive: boolean): Promise<Entry> {
    const type = this.types(config.type);
    if (!type)
      return {
        config,
        api: empty(),
        status: { state: "failed", message: `Unknown mount type "${config.type}"` },
      };
    try {
      const api = await type.create(config, {
        interactive,
        locked: this.isLocked(),
        secret: (field) => this.secrets(config, field),
      });
      return { config, api, status: { state: "mounted" } };
    } catch (error) {
      const status: MountStatus =
        error instanceof NeedsUserGesture
          ? { state: "needs-access" }
          : error instanceof SecretsLocked
            ? { state: "locked" }
            : { state: "failed", message: error instanceof Error ? error.message : String(error) };
      return { config, api: empty(), status };
    }
  }
}

function sameMount(a: MountConfig, b: MountConfig): boolean {
  return a.type === b.type && canonical(a.config) === canonical(b.config);
}

function canonical(config: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(config)
      .sort()
      .map((k) => [k, config[k]]),
  );
}
