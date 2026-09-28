import type { Widget } from "@theia/core/lib/browser";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import {
  ApplicationShell,
  applicationShellLayoutVersion,
} from "@theia/core/lib/browser/shell/application-shell";
import {
  PERSPECTIVE_LAYOUTS_STORAGE_KEY,
  type PersistedPerspectiveData,
  ShellLayoutRestorer,
  type WidgetDescription,
} from "@theia/core/lib/browser/shell/shell-layout-restorer";
import { StorageService } from "@theia/core/lib/browser/storage-service";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import type { Disposable } from "@theia/core/lib/common/disposable";
import { ILogger } from "@theia/core/lib/common/logger";
import { inject, injectable, named } from "@theia/core/shared/inversify";
import { VaultService } from "@theia-shell/theia-secret-vault/lib/browser/vault-service";
import {
  descriptionKey,
  layoutAreas,
  layoutMountKeys,
  livePending,
  mergePending,
  mountKeyOf,
  type RestoreArea,
  storedPending,
  unfailedPending,
  within,
} from "../common/restore";
import { SerialQueue } from "../common/serial-queue";
import { MountService } from "./mount-service";

/**
 * A shell widget Theia could not re-create when it restored the layout.
 * `context` is the restore's own; one kept from an earlier session (see
 * `MountsRestore`) has none and is re-created in a fresh one.
 */
export interface RestoreFailure {
  readonly description: WidgetDescription;
  readonly context?: ShellLayoutRestorer.InflateContext;
  readonly area: RestoreArea;
}

/**
 * Theia's layout restorer, unchanged except that it remembers the shell's
 * widgets it could not re-create (Theia drops them), with their area, so that
 * they can be re-created later — through the same restorer, with their state.
 *
 * Assumes one perspective, as this app has: Theia inflates every saved
 * perspective's layout, so a failure in an inactive one would be reopened
 * into the active shell, and `areas` (keyed by description) could mix up two
 * perspectives holding the same widget in different areas.
 */
@injectable()
export class MountsLayoutRestorer extends ShellLayoutRestorer {
  protected readonly areas = new Map<string, RestoreArea>();
  protected failures: RestoreFailure[] = [];

  constructor(
    @inject(WidgetManager) widgetManager: WidgetManager,
    @inject(ILogger) @named("core:ShellLayoutRestorer") logger: ILogger,
    @inject(StorageService) storageService: StorageService,
  ) {
    super(widgetManager, logger, storageService);
  }

  /** The widgets that failed since the last call. */
  takeFailures(): RestoreFailure[] {
    const failures = this.failures;
    this.failures = [];
    return failures;
  }

  /** Re-creates a widget that failed at restore; undefined if it fails again. */
  recreate(failure: RestoreFailure): Promise<Widget | undefined> {
    const context = failure.context ?? {
      layout: {},
      layoutVersion: applicationShellLayoutVersion,
      migrations: [],
    };
    return super.convertToWidget(failure.description, context);
  }

  /**
   * The mounts the stored layout's widgets live on, read where Theia reads it
   * (the perspectives' layouts, or the single legacy one), before it does.
   */
  async savedMountKeys(): Promise<string[]> {
    const layouts: unknown[] = [];
    const perspectives = await this.storageService.getData<PersistedPerspectiveData>(
      PERSPECTIVE_LAYOUTS_STORAGE_KEY,
    );
    if (perspectives?.layouts) layouts.push(...Object.values(perspectives.layouts));
    else layouts.push(await this.storageService.getData<string>(this.storageKey));
    const keys = new Set<string>();
    for (const layout of layouts) {
      if (typeof layout !== "string") continue;
      try {
        for (const key of layoutMountKeys(JSON.parse(layout))) keys.add(key);
      } catch {
        // Not JSON: Theia's own inflate reports it.
      }
    }
    return [...keys];
  }

  protected override async inflate(layoutData: string): Promise<ApplicationShell.LayoutData> {
    try {
      for (const [key, area] of layoutAreas(JSON.parse(layoutData))) this.areas.set(key, area);
    } catch {
      // Not JSON: Theia's own inflate reports it.
    }
    return super.inflate(layoutData);
  }

  protected override async convertToWidget(
    desc: WidgetDescription,
    context: ShellLayoutRestorer.InflateContext,
  ): Promise<Widget | undefined> {
    const widget = await super.convertToWidget(desc, context);
    // Only the shell's own widgets: a nested one belongs to its parent's state.
    if (!widget && !context.parent && desc.constructionOptions) {
      const area = this.areas.get(descriptionKey(desc.constructionOptions)) ?? "main";
      this.failures.push({ description: desc, context, area });
    }
    return widget;
  }
}

/**
 * Restoring the layout waits for the mounts it needs, and what still could not
 * be restored reopens once its mount is up — also after further reloads.
 *
 * - `onStart` (Theia awaits it before restoring the layout) waits until the
 *   mounts the stored layout (and the pending reopens) use have been applied
 *   — `MountService.applyStartup`; the others do not delay start-up — and, if
 *   one of them is locked behind the vault, for the vault's start-up prompt
 *   and the re-creation an unlock queues. Each non-interactive wait is bounded
 *   by `startupTimeout`; the user's own time is not: the boot gate (before the
 *   main storage opens) and a shown vault prompt both have a way out.
 *   The vault's `onStart`, which starts that prompt, runs first: the vault
 *   module loads before this one (this package depends on it) and Theia runs
 *   the `onStart`s in binding order; were it otherwise, the bound would end
 *   the wait, not a hang.
 * - A file-backed widget (an editor, a viewer, the Markdown preview: a `file:`
 *   `uri` option) on a mount that was not mounted when the layout was restored
 *   is re-created in its area as soon as that mount is `mounted` (after an
 *   unlock, a Reconnect, a slow start). Everything else Theia could not
 *   restore stays dropped.
 * - The widgets still waiting are kept in the `StorageService` (Theia stores
 *   the layout on unload without them), and merged back after the next restore.
 */
@injectable()
export class MountsRestore implements FrontendApplicationContribution {
  @inject(MountService) protected readonly mounts!: MountService;
  @inject(MountsLayoutRestorer) protected readonly restorer!: MountsLayoutRestorer;
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
  @inject(WidgetManager) protected readonly widgets!: WidgetManager;
  @inject(StorageService) protected readonly storage!: StorageService;
  @inject(VaultService) protected readonly vaults!: VaultService;
  @inject(ILogger) protected readonly logger!: ILogger;

  /** How long start-up waits for a non-interactive step before restoring the layout anyway (ms). */
  protected readonly startupTimeout = 30_000;
  /** Where the pending reopens are kept across reloads. */
  protected readonly storageKey = "theia-shell.mounts.pending-reopens";
  protected pending: RestoreFailure[] = [];
  protected readonly queue = new SerialQueue();
  protected listener: Disposable | undefined;

  /** The mounts restoring needs: those of the stored layout and of the pending reopens. */
  async startupMountKeys(): Promise<string[]> {
    const keys = new Set(await this.restorer.savedMountKeys());
    for (const entry of await this.storedPending()) {
      const key = mountKeyOf(entry.description.constructionOptions.options);
      if (key !== undefined) keys.add(key);
    }
    return [...keys];
  }

  async onStart(): Promise<void> {
    // The boot gate (a local-folder main storage) waits for a click: the user's time.
    await this.mounts.start();
    if (!(await within(this.mounts.whenStartupApplied(), this.startupTimeout))) {
      return this.notSettled();
    }
    if (!this.mounts.startupLocked()) return;
    if (!(await this.vaultAnswered())) return this.notSettled();
    if (!this.vaults.current?.unlocked) return; // skipped: the tabs reopen after a later unlock
    // The re-creation the unlock queued; the bound restarts after the answer.
    if (!(await within(this.mounts.idle(), this.startupTimeout))) this.notSettled();
  }

  /** Waits for the vault's start-up prompt; unbounded once it is shown (it has Skip). */
  protected async vaultAnswered(): Promise<boolean> {
    if (await within(this.vaults.startupUnlock, this.startupTimeout)) return true;
    if (!this.vaults.startupPromptShown) return false;
    await this.vaults.startupUnlock;
    return true;
  }

  protected notSettled(): void {
    this.logger.warn(
      `Mounts: not settled after ${this.startupTimeout / 1000} s; restoring the layout anyway`,
    );
  }

  async onDidInitializeLayout(): Promise<void> {
    // Also those whose mount is mounted by now (an unlock during the restore):
    // the first reopen below retries them once, and drops a real failure.
    const failures = this.restorer
      .takeFailures()
      .filter((failure) => mountKeyOf(failure.description.constructionOptions.options));
    await this.mounts.whenStartupApplied();
    // A stored one whose mount failed to come up is forgotten (it would hold up every start).
    const stored = unfailedPending(await this.storedPending(), (key) => this.mounts.status(key));
    this.pending = mergePending<RestoreFailure>(failures, stored);
    this.store();
    if (!this.pending.length) return;
    this.listener = this.mounts.onDidChangeStatus(() => this.reopenQueued());
    void this.reopenQueued();
  }

  /**
   * The stored pending reopens on mounts in the workspace (see `livePending`).
   * Reads `files.mounts`: only once the preferences are ready — true while
   * `MountService` asks for the start-up keys, and once the start-up apply is done.
   */
  protected async storedPending(): Promise<RestoreFailure[]> {
    const stored = storedPending(await this.storage.getData(this.storageKey)) as RestoreFailure[];
    return livePending(stored, this.mounts.configuredMounts());
  }

  /** Keeps the pending reopens for the next session (nothing once none is left). */
  protected store(): void {
    const entries = this.pending.map(({ description, area }) => ({ description, area }));
    this.storage
      .setData(this.storageKey, entries.length ? entries : undefined)
      .catch((e) => this.logger.error("Mounts: could not keep the files to reopen", e));
  }

  protected reopenQueued(): Promise<void> {
    return this.queue
      .run(() => this.reopen())
      .catch((e) => this.logger.error("Mounts: could not reopen a restored file", e));
  }

  /** Re-creates the pending widgets whose mount is up now; one failing again is dropped. */
  protected async reopen(): Promise<void> {
    // Only files on configured mounts: not the main storage (always up — a
    // failure there is the file's own) nor a mount removed since.
    await this.mounts.whenConfigured();
    const configured = new Set(this.mounts.configuredMounts().map((m) => m.key));
    this.pending = this.pending.filter((failure) =>
      configured.has(mountKeyOf(failure.description.constructionOptions.options) as string),
    );
    const ready = this.pending.filter((failure) => {
      const key = mountKeyOf(failure.description.constructionOptions.options) as string;
      return this.mounts.status(key)?.state === "mounted";
    });
    this.pending = this.pending.filter((failure) => !ready.includes(failure));
    this.store();
    for (const failure of ready) {
      if (this.isOpen(failure)) continue;
      const widget = await this.restorer.recreate(failure);
      if (widget && !widget.isAttached) await this.shell.addWidget(widget, { area: failure.area });
    }
    if (!this.pending.length) {
      this.listener?.dispose();
      this.listener = undefined;
    }
  }

  /** Whether the user opened the same file with the same kind of widget meanwhile. */
  protected isOpen(failure: RestoreFailure): boolean {
    const { factoryId, options } = failure.description.constructionOptions;
    const uri = (options as { uri?: unknown }).uri;
    return this.widgets
      .getWidgets(factoryId)
      .some((w) => (this.widgets.getDescription(w)?.options as { uri?: unknown })?.uri === uri);
  }
}
