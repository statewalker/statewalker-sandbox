import type { Widget } from "@theia/core/lib/browser";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import {
  ShellLayoutRestorer,
  type WidgetDescription,
} from "@theia/core/lib/browser/shell/shell-layout-restorer";
import { StorageService } from "@theia/core/lib/browser/storage-service";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import type { Disposable } from "@theia/core/lib/common/disposable";
import { ILogger } from "@theia/core/lib/common/logger";
import { inject, injectable, named } from "@theia/core/shared/inversify";
import {
  descriptionKey,
  layoutAreas,
  mountKeyOf,
  type RestoreArea,
  within,
} from "../common/restore";
import { SerialQueue } from "../common/serial-queue";
import { MountService } from "./mount-service";

/** A shell widget Theia could not re-create when it restored the layout. */
export interface RestoreFailure {
  readonly description: WidgetDescription;
  readonly context: ShellLayoutRestorer.InflateContext;
  readonly area: RestoreArea;
}

/**
 * Theia's layout restorer, unchanged except that it remembers the shell's
 * widgets it could not re-create (Theia drops them), with their area, so that
 * they can be re-created later — through the same restorer, with their state.
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
    return super.convertToWidget(failure.description, failure.context);
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
 * Restoring the layout waits for the mounts, and what still could not be
 * restored reopens once its mount is up.
 *
 * - `onStart` (Theia awaits it before restoring the layout) waits until the
 *   mounts have settled — see `MountService.settled` — for at most
 *   `startupTimeout`; then startup goes on regardless.
 * - A file-backed widget (an editor, a viewer: a `file:` `uri` option) on a
 *   mount that was not mounted when the layout was restored is re-created in
 *   its area as soon as that mount is `mounted` (after an unlock, a Reconnect,
 *   a slow start). Everything else Theia could not restore stays dropped.
 */
@injectable()
export class MountsRestore implements FrontendApplicationContribution {
  @inject(MountService) protected readonly mounts!: MountService;
  @inject(MountsLayoutRestorer) protected readonly restorer!: MountsLayoutRestorer;
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
  @inject(WidgetManager) protected readonly widgets!: WidgetManager;
  @inject(ILogger) protected readonly logger!: ILogger;

  /** How long startup waits for the mounts before restoring the layout anyway (ms). */
  protected readonly startupTimeout = 30_000;
  protected pending: RestoreFailure[] = [];
  protected readonly queue = new SerialQueue();
  protected listener: Disposable | undefined;

  async onStart(): Promise<void> {
    if (!(await within(this.mounts.settled(), this.startupTimeout))) {
      this.logger.warn(
        `Mounts: not settled after ${this.startupTimeout / 1000} s; restoring the layout anyway`,
      );
    }
  }

  onDidInitializeLayout(): void {
    this.pending = this.restorer.takeFailures().filter((failure) => {
      const key = mountKeyOf(failure.description.constructionOptions.options);
      return key !== undefined && this.mounts.status(key)?.state !== "mounted";
    });
    if (!this.pending.length) return;
    this.listener = this.mounts.onDidChangeStatus(() => this.reopenQueued());
    void this.reopenQueued();
  }

  protected reopenQueued(): Promise<void> {
    return this.queue
      .run(() => this.reopen())
      .catch((e) => this.logger.error("Mounts: could not reopen a restored file", e));
  }

  /** Re-creates the pending widgets whose mount is up now; one failing again is dropped. */
  protected async reopen(): Promise<void> {
    const ready = this.pending.filter((failure) => {
      const key = mountKeyOf(failure.description.constructionOptions.options) as string;
      return this.mounts.status(key)?.state === "mounted";
    });
    this.pending = this.pending.filter((failure) => !ready.includes(failure));
    for (const failure of ready) {
      if (this.isOpen(failure)) continue;
      const widget = await this.restorer.recreate(failure);
      if (widget && !widget.isAttached) await this.shell.addWidget(widget, { area: failure.area });
    }
    if (!this.pending.length) this.listener?.dispose();
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
