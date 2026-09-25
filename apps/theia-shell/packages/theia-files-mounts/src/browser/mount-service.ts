import type { FilesApi } from "@statewalker/webrun-files";
import { CompositeFilesApi, readOnly } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { CredentialsService } from "@theia/core/lib/browser/credentials-service";
import { ContributionProvider } from "@theia/core/lib/common/contribution-provider";
import { Emitter, type Event } from "@theia/core/lib/common/event";
import { MessageService } from "@theia/core/lib/common/message-service";
import { PreferenceScope, PreferenceService } from "@theia/core/lib/common/preferences";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable, named } from "@theia/core/shared/inversify";
import type { FilesApiChange } from "@theia-shell/theia-files-api";
import { VaultService } from "@theia-shell/theia-secret-vault/lib/browser/vault-service";
import { applyLayers, FilesApiLayer } from "../common/layers";
import { validateMountConfigs } from "../common/mount-config";
import { type ApplyOptions, MountTable } from "../common/mount-table";
import { type MountConfig, type MountStatus, MountType } from "../common/mount-types";
import { MountedFilesApi } from "../common/mounted-files-api";
import { MainStorageService } from "./main-storage";
import {
  HIDDEN_PREFERENCE,
  MOUNT_SECRETS_SERVICE,
  MOUNTS_PREFERENCE,
  MountDefaults,
} from "./mount-preferences";

/**
 * Owns the root FilesApi: the main storage plus the `files.mounts` mounts,
 * wrapped in the layers. `start()` resolves as soon as the main storage is
 * open — it never waits for preferences, because folder-scope preferences are
 * read through this root — and the other mounts follow as reported changes.
 */
@injectable()
export class MountService {
  @inject(MainStorageService) protected readonly main!: MainStorageService;
  @inject(PreferenceService) protected readonly preferences!: PreferenceService;
  @inject(CredentialsService) protected readonly credentials!: CredentialsService;
  @inject(VaultService) protected readonly vaults!: VaultService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(MountDefaults) protected readonly defaults!: MountDefaults;
  @inject(ContributionProvider)
  @named(MountType)
  protected readonly typeProvider!: ContributionProvider<MountType>;
  @inject(ContributionProvider)
  @named(FilesApiLayer)
  protected readonly layerProvider!: ContributionProvider<FilesApiLayer>;

  readonly root = new MountedFilesApi(new CompositeFilesApi(readOnly(new MemFilesApi())));
  protected readonly table = new MountTable(
    (id) => this.types().get(id),
    (mount, field) => this.credentials.getPassword(MOUNT_SECRETS_SERVICE, `${mount.key}/${field}`),
    () => !this.vaults.current?.unlocked,
  );
  protected mainMount: { config: MountConfig; api: FilesApi } | undefined;
  protected started: Promise<FilesApi> | undefined;
  protected readonly reported = new Set<string>();
  protected queue: Promise<void> = Promise.resolve();

  protected readonly changeEmitter = new Emitter<readonly FilesApiChange[]>();
  readonly onDidChange: Event<readonly FilesApiChange[]> = this.changeEmitter.event;
  protected readonly statusEmitter = new Emitter<void>();
  readonly onDidChangeStatus: Event<void> = this.statusEmitter.event;

  start(): Promise<FilesApi> {
    this.started ??= this.doStart();
    return this.started;
  }

  protected async doStart(): Promise<FilesApi> {
    const opened = await this.main.open();
    const { key, name } = opened.storage;
    this.mainMount = { config: { key, name, type: "main", config: {} }, api: opened.files };
    await this.apply([]);
    void this.preferences.ready.then(() => this.applyPreferences());
    this.preferences.onPreferenceChanged((event) => {
      if (event.preferenceName === MOUNTS_PREFERENCE) void this.applyPreferences();
      if (event.preferenceName === HIDDEN_PREFERENCE)
        this.rebuild([{ type: "updated", path: "/" }]);
    });
    this.vaults.onDidUnlock(
      () => void this.applyPreferences({ recreate: (_key, s) => s.state === "locked" }),
    );
    for (const layer of this.layerProvider.getContributions()) {
      layer.onDidChange?.(() => this.rebuild([{ type: "updated", path: "/" }]));
    }
    return this.root;
  }

  types(): Map<string, MountType> {
    return new Map(this.typeProvider.getContributions().map((t) => [t.id, t]));
  }

  mainKey(): string | undefined {
    return this.mainMount?.config.key;
  }

  status(key: string): MountStatus | undefined {
    return this.table.status(key);
  }

  /** The mount a root-level folder URI stands for (main included). */
  mountAt(uri: URI): MountConfig | undefined {
    const segments = uri.path.toString().split("/").filter(Boolean);
    if (segments.length !== 1) return undefined;
    return this.table.configs().find((c) => c.key === segments[0]);
  }

  /** `files.mounts` as set, or the app's defaults when unset. */
  configuredMounts(): MountConfig[] {
    const set: unknown = this.preferences.inspect(MOUNTS_PREFERENCE)?.globalValue;
    return Array.isArray(set) ? (set as MountConfig[]) : this.defaults.mounts;
  }

  /** Adds or replaces a mount (and its secrets), then saves `files.mounts`. */
  async saveMount(
    config: MountConfig,
    secrets: Record<string, string>,
    previousKey?: string,
  ): Promise<void> {
    const type = this.types().get(config.type);
    const secretFields = type?.fields.filter((f) => f.kind === "secret").map((f) => f.name) ?? [];
    if (previousKey && previousKey !== config.key) {
      for (const field of secretFields) {
        if (field in secrets) continue;
        const value = await this.credentials.getPassword(
          MOUNT_SECRETS_SERVICE,
          `${previousKey}/${field}`,
        );
        if (value !== undefined) secrets[field] = value;
        await this.credentials.deletePassword(MOUNT_SECRETS_SERVICE, `${previousKey}/${field}`);
      }
    }
    for (const [field, value] of Object.entries(secrets)) {
      await this.credentials.setPassword(MOUNT_SECRETS_SERVICE, `${config.key}/${field}`, value);
    }
    const list = this.configuredMounts();
    const index = list.findIndex((m) => m.key === (previousKey ?? config.key));
    const next = [...list];
    if (index >= 0) next.splice(index, 1, config);
    else next.push(config);
    await this.preferences.set(MOUNTS_PREFERENCE, next, PreferenceScope.User);
  }

  async unmount(key: string): Promise<void> {
    const config = this.configuredMounts().find((m) => m.key === key);
    if (!config) return;
    const type = this.types().get(config.type);
    for (const field of type?.fields.filter((f) => f.kind === "secret") ?? []) {
      await this.credentials.deletePassword(MOUNT_SECRETS_SERVICE, `${key}/${field.name}`);
    }
    await type?.forget?.(config);
    await this.preferences.set(
      MOUNTS_PREFERENCE,
      this.configuredMounts().filter((m) => m.key !== key),
      PreferenceScope.User,
    );
  }

  /** From a click: re-creates one mount with `interactive` true (grants folder access). */
  reconnect(key: string): Promise<void> {
    return this.applyPreferences({ interactive: true, recreate: (k) => k === key });
  }

  protected applyPreferences(options: ApplyOptions = {}): Promise<void> {
    const reserved = this.mainKey() ? [this.mainKey() as string] : [];
    const { valid, errors } = validateMountConfigs(this.configuredMounts(), this.types(), reserved);
    for (const error of errors) {
      if (this.reported.has(error)) continue;
      this.reported.add(error);
      this.messages.warn(`Mounts: ${error}`);
    }
    return this.apply(valid, options);
  }

  /** Serialized: a slow S3 mount must not let an older apply overwrite a newer one. */
  protected apply(configs: MountConfig[], options: ApplyOptions = {}): Promise<void> {
    this.queue = this.queue.then(async () => {
      const fixed = this.mainMount ? [this.mainMount] : [];
      this.rebuild(await this.table.apply(configs, { ...options, fixed }));
    });
    return this.queue;
  }

  protected rebuild(changes: FilesApiChange[]): void {
    this.root.setTarget(applyLayers(this.table.composite(), this.layerProvider.getContributions()));
    if (changes.length) this.changeEmitter.fire(changes);
    this.statusEmitter.fire();
  }
}
