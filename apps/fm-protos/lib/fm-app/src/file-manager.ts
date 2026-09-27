import {
  ChangeNotifier,
  type FileRef,
  filesCopy,
  filesResolveActions,
  type JobModel,
  JobQueue,
  registerFileCommands,
  type StorageConfig,
  type StorageRegistry,
} from "@fm/core";
import type { Commands } from "@statewalker/shared-commands";
import {
  CONFIG_VERSION,
  type ConfigStore,
  degradedPanel,
  type SessionFile,
} from "./config-store.js";
import { createConflictResolver } from "./conflict-resolver.js";
import { PanelController } from "./panel-controller.js";
import { PanelsModel } from "./panels-model.js";
import { TableModel } from "./table-model.js";
import { MenuModel, uiShowMenu } from "./ui-declarations.js";

export interface FileManagerOptions {
  commands: Commands;
  registry: StorageRegistry;
  config: ConfigStore;
  slots: string[];
}

export interface OpenPanel {
  id: string;
  controller: PanelController;
  table: TableModel;
}

/**
 * D5 — the assembly.
 *
 * Everything below is already tested in isolation; this is the wiring, and the
 * wiring is where the layering either holds or quietly stops holding. It owns
 * no rules of its own: it constructs the pieces, connects them in the fixed
 * bootstrap order, and gets out of the way.
 */
export class FileManager {
  readonly panels: PanelsModel;
  readonly jobs: JobQueue;
  readonly notifier: ChangeNotifier;

  private readonly _open = new Map<string, OpenPanel>();
  private readonly _disposers: (() => void)[] = [];

  constructor(private readonly _options: FileManagerOptions) {
    this.panels = new PanelsModel({ slots: _options.slots });
    this.notifier = new ChangeNotifier(_options.registry);
    this.jobs = new JobQueue(_options.registry, { checkpoints: undefined });

    // The core's file commands, at negative priority, as always.
    this._disposers.push(
      registerFileCommands(_options.commands, {
        queue: this.jobs,
        resolve: (uri) => this._resolveSync(uri),
      }),
    );
  }

  private _resolveSync(uri: string) {
    const open = [...this._open.values()].find((p) => p.controller.model.storage === uri);
    if (!open) throw new Error(`No open panel holds ${uri}`);
    return open.controller.api;
  }

  async addPanel(storage: string, path: string): Promise<OpenPanel> {
    const model = this.panels.add({ storage, path });
    const handle = await this._options.registry.acquire(storage, `panel:${model.id}`);
    const table = new TableModel();
    const controller = new PanelController(model, handle.api, this._options.commands, () => {});

    model.onUpdate(() => {
      table.setRows(model.visible);
      table.marks = model.marks;
      this._scheduleSession();
    });
    controller.subscribe(this.notifier);
    await controller.activate();

    const open: OpenPanel = { id: model.id, controller, table };
    this._open.set(model.id, open);
    this._scheduleSession();
    return open;
  }

  panel(id: string): OpenPanel {
    const open = this._open.get(id);
    if (!open) throw new Error(`Unknown panel: ${id}`);
    return open;
  }

  async removePanel(id: string): Promise<void> {
    const open = this.panel(id);
    const storage = open.controller.model.storage;
    open.controller.dispose();
    this._open.delete(id);
    this.panels.remove(id);
    this._options.registry.release(storage, `panel:${id}`);
    this._scheduleSession();
  }

  /**
   * A copy from a panel: the target is chosen by the MRU rule (C2) and the
   * command carries resolved locations, so a picker is only shown when there
   * is a genuine choice to make.
   */
  copyFromPanel(sourceId: string, files: FileRef[]): Promise<{ jobId: string }> {
    const target = this.panels.targetFor(sourceId);
    if (!target) throw new Error("no target panel: operations need two panels");
    const targetPanel = this.panels.get(target.id);
    return this._options.commands.call(filesCopy, {
      files,
      target: { storage: targetPanel.storage, path: targetPanel.path },
    }).promise;
  }

  /** The menu is the registry, filtered by what the host says applies. */
  async menuFor(files: FileRef[]): Promise<{ selectedKey?: string }> {
    const { keys } = await this._options.commands.call(filesResolveActions, { files }).promise;
    return this._options.commands.call(uiShowMenu, new MenuModel(keys.map((key) => ({ key }))))
      .promise;
  }

  conflictResolver() {
    return createConflictResolver(this._options.commands);
  }

  session(): SessionFile {
    return {
      version: CONFIG_VERSION,
      activeId: this.panels.activeId,
      panels: this.panels.order.map((id) => {
        const model = this.panels.get(id);
        return {
          id,
          storage: model.storage,
          path: model.path,
          name: model.name,
          slot: model.slot,
        };
      }),
    };
  }

  /** Restores what it can, and names what it cannot. */
  async restore(session: SessionFile, configured: StorageConfig[]): Promise<string[]> {
    const known = new Set(configured.map((c) => c.uri));
    const unavailable: string[] = [];
    for (const panel of session.panels) {
      const degraded = degradedPanel(panel, known);
      if (degraded.error) {
        unavailable.push(degraded.name);
        this.panels.add({ storage: panel.storage, path: panel.path, name: panel.name });
        continue;
      }
      await this.addPanel(panel.storage, panel.path);
    }
    return unavailable;
  }

  private _scheduleSession(): void {
    this._options.config.scheduleSession(this.session());
  }

  activeJob(): JobModel | undefined {
    return this.jobs.active()[0];
  }

  async dispose(): Promise<void> {
    for (const id of [...this._open.keys()]) await this.removePanel(id);
    for (const off of this._disposers) off();
    this.notifier.dispose();
    this._options.config.dispose();
  }
}
