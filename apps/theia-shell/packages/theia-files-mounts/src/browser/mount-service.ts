import type { FilesApi } from "@statewalker/webrun-files";
import { CompositeFilesApi, readOnly } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { CredentialsService } from "@theia/core/lib/browser/credentials-service";
import { ContributionProvider } from "@theia/core/lib/common/contribution-provider";
import { Emitter, type Event } from "@theia/core/lib/common/event";
import { MessageService } from "@theia/core/lib/common/message-service";
import { PreferenceScope, PreferenceService } from "@theia/core/lib/common/preferences";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable, named } from "@theia/core/shared/inversify";
import type { FileService } from "@theia/filesystem/lib/browser/file-service";
import type { FilesApiChange } from "@theia-shell/theia-files-api";
import { VaultService } from "@theia-shell/theia-secret-vault/lib/browser/vault-service";
import { applyLayers, FilesApiLayer } from "../common/layers";
import { isMounted, mountsSetting, validateMountConfigs } from "../common/mount-config";
import { type ApplyOptions, MountTable } from "../common/mount-table";
import { type MountConfig, type MountStatus, MountType } from "../common/mount-types";
import { MountedFilesApi } from "../common/mounted-files-api";
import { SerialQueue } from "../common/serial-queue";
import { WORKSPACE_FOLDER } from "../common/system-folder";
import {
  updateWorkspaceFile,
  WORKSPACE_FILE_URI,
  WORKSPACE_MOUNT_KEY,
  workspaceRoots,
} from "../common/workspace-file";
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
export const LazyFileService = Symbol("LazyFileService");
export type LazyFileService = () => FileService;

@injectable()
export class MountService {
  @inject(MainStorageService) protected readonly main!: MainStorageService;
  @inject(PreferenceService) protected readonly preferences!: PreferenceService;
  @inject(CredentialsService) protected readonly credentials!: CredentialsService;
  @inject(VaultService) protected readonly vaults!: VaultService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(MountDefaults) protected readonly defaults!: MountDefaults;
  /** Resolved lazily: FileService builds the FilesApi provider, which subscribes to this service. */
  @inject(LazyFileService) protected readonly fileService!: LazyFileService;
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
  protected workspaceMount: { config: MountConfig; api: FilesApi } | undefined;
  protected workspaceSynced: Promise<void> = Promise.resolve();
  protected started: Promise<FilesApi> | undefined;
  protected readonly reported = new Set<string>();
  /** Every change to the tree, one at a time; a failed step is reported and the next still runs. */
  protected readonly queue = new SerialQueue();

  protected readonly changeEmitter = new Emitter<readonly FilesApiChange[]>();
  readonly onDidChange: Event<readonly FilesApiChange[]> = this.changeEmitter.event;
  protected readonly layersEmitter = new Emitter<void>();
  /** Fires after a filter layer changed what the mounts show. */
  readonly onDidChangeLayers: Event<void> = this.layersEmitter.event;
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
    // The workspace file's folder: a system mount, never a root.
    this.workspaceMount = {
      config: { key: WORKSPACE_MOUNT_KEY, name: "Workspace", type: "system", config: {} },
      api: new CompositeFilesApi(opened.files, WORKSPACE_FOLDER),
    };
    // Only the fixed mounts yet: create the workspace file if missing, never
    // cut an existing one down to "main only" (the real list follows).
    await this.apply([], {}, { createOnly: true });
    this.preferences.ready.then(() => this.applyPreferences()).catch((e) => this.report(e));
    this.preferences.onPreferenceChanged((event) => {
      if (event.preferenceName === MOUNTS_PREFERENCE)
        this.applyPreferences().catch((e) => this.report(e));
      if (event.preferenceName === HIDDEN_PREFERENCE) this.rebuildQueued();
    });
    this.vaults.onDidUnlock(() =>
      this.applyPreferences({ recreate: (_key, s) => s.state === "locked" }).catch((e) =>
        this.report(e),
      ),
    );
    for (const layer of this.layerProvider.getContributions()) {
      layer.onDidChange?.(() => this.rebuildQueued());
    }
    return this.root;
  }

  types(): Map<string, MountType> {
    return new Map(this.typeProvider.getContributions().map((t) => [t.id, t]));
  }

  /** Keys no mount may take: the main storage's and the system mounts'. */
  reservedKeys(): string[] {
    return [...(this.mainKey() ? [this.mainKey() as string] : []), WORKSPACE_MOUNT_KEY];
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

  /** Removes a folder from the workspace but remembers it: configuration, secrets and local handle stay. */
  async unmount(key: string): Promise<void> {
    await this.saveMounts(this.withMounted(key, false));
  }

  /** From a click: brings a remembered folder back (the click may grant folder access). */
  async remount(key: string): Promise<void> {
    const next = this.withMounted(key, true);
    await this.saveMounts(next);
    await this.applyList(next, { interactive: true, recreate: (k) => k === key });
  }

  /** The valid `files.mounts` entries, mounted or remembered (malformed ones are left out). */
  validMounts(): MountConfig[] {
    const raw: unknown = this.preferences.inspect(MOUNTS_PREFERENCE)?.globalValue;
    return validateMountConfigs(
      mountsSetting(raw, this.defaults.mounts),
      this.types(),
      this.reservedKeys(),
    ).valid;
  }

  /** The folders not in the workspace, remembered to be added back. */
  rememberedMounts(): MountConfig[] {
    return this.configuredMounts().filter((m) => !isMounted(m));
  }

  /** Deletes a mount for good: its entry, its secrets and what its type stored (a local handle). */
  async forget(key: string): Promise<void> {
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

  protected withMounted(key: string, mounted: boolean): MountConfig[] {
    return this.configuredMounts().map((m) => {
      if (m.key !== key) return m;
      const { mounted: _, ...rest } = m;
      return mounted ? rest : { ...rest, mounted: false };
    });
  }

  protected saveMounts(list: MountConfig[]): Promise<void> {
    return this.preferences.set(MOUNTS_PREFERENCE, list, PreferenceScope.User);
  }

  protected applyPreferences(options: ApplyOptions = {}): Promise<void> {
    const raw: unknown = this.preferences.inspect(MOUNTS_PREFERENCE)?.globalValue;
    return this.applyList(mountsSetting(raw, this.defaults.mounts), options);
  }

  /** Validates a `files.mounts` value, reports what is wrong, and mounts the mounted entries. */
  protected applyList(raw: unknown, options: ApplyOptions = {}): Promise<void> {
    const reserved = this.reservedKeys();
    const { valid, errors } = validateMountConfigs(raw, this.types(), reserved);
    for (const error of errors) {
      if (this.reported.has(error)) continue;
      this.reported.add(error);
      this.messages.warn(`Mounts: ${error}`);
    }
    return this.apply(valid.filter(isMounted), options);
  }

  /** Serialized: a slow S3 mount must not let an older apply overwrite a newer one. */
  protected apply(
    configs: MountConfig[],
    options: ApplyOptions = {},
    sync: { createOnly?: boolean } = {},
  ): Promise<void> {
    const applied = this.queue.run(async () => {
      const fixed = [this.mainMount, this.workspaceMount].filter((m) => m !== undefined);
      this.rebuild(await this.table.apply(configs, { ...options, fixed }));
    });
    // A step of its own: writing goes through Theia's FileService and so back
    // through this root, which must not wait for itself (start() awaits apply).
    this.workspaceSynced = this.queue.run(() => this.syncWorkspaceFile(sync));
    this.workspaceSynced.catch((e) => this.report(e));
    return applied;
  }

  /** Resolves once the workspace file matches the mounts applied so far. */
  workspaceReady(): Promise<void> {
    return this.workspaceSynced.catch(() => undefined);
  }

  /** Keeps the workspace file's folders equal to the mounted keys (main first): the mounts are the roots. */
  protected async syncWorkspaceFile(sync: { createOnly?: boolean } = {}): Promise<void> {
    const uri = new URI(WORKSPACE_FILE_URI);
    const files = this.fileService();
    const existing = (await files.exists(uri)) ? (await files.read(uri)).value : undefined;
    const next = updateWorkspaceFile(existing, workspaceRoots(this.table.configs()), sync);
    if (next !== undefined) await files.write(uri, next);
  }

  /** A rebuild that changes what every mount shows (a filter). */
  protected rebuildQueued(): void {
    this.queue
      .run(async () => {
        this.rebuild([{ type: "updated", path: "/" }]);
        this.layersEmitter.fire();
      })
      .catch((e) => this.report(e));
  }

  protected report(error: unknown): void {
    this.messages.error(`Mounts: ${error instanceof Error ? error.message : String(error)}`);
  }

  protected rebuild(changes: FilesApiChange[]): void {
    this.root.setTarget(applyLayers(this.table.composite(), this.layerProvider.getContributions()));
    if (changes.length) this.changeEmitter.fire(changes);
    this.statusEmitter.fire();
  }
}
