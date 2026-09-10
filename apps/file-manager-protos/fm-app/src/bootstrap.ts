import type { JobModel } from "@fm/core";
import type { Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import { ChangeNotifier, type ChangeNotifierOptions } from "./change-notifier.js";
import { JobsController } from "./jobs-controller.js";
import { PanelController } from "./panel-controller.js";
import { PanelModel } from "./panel-model.js";

export interface PanelSpec {
  id: string;
  slot: string;
  storage: string;
  path: string;
}

export interface BootstrapOptions {
  commands: Commands;
  storages: Record<string, FilesApi>;
  panels: PanelSpec[];
  /** Per-storage poll intervals. Absent means polling is off, which is the default. */
  notifications?: ChangeNotifierOptions;
}

export interface App {
  panels: { get(id: string): PanelModel; remove(id: string): Promise<void> };
  jobs: { get(id: string): JobModel; lastJobId(): string | undefined };
  /** The producer-agnostic entry point. A host, a poll or a job all arrive here. */
  changes: ChangeNotifier;
  settled(): Promise<void>;
  dispose(): void;
  debug: { panelReactions: number };
}

/**
 * Bootstrap order is fixed and is what makes `Command.required` correct
 * everywhere: the caller registers view handlers BEFORE calling this, so a
 * missing handler is unambiguously a wiring bug rather than a startup race.
 */
export async function bootstrap(options: BootstrapOptions): Promise<App> {
  const { commands, storages } = options;
  const resolve = (storage: string): FilesApi => {
    const api = storages[storage];
    if (!api) throw new Error(`Unknown storage: ${storage}`);
    return api;
  };

  const controllers = new Map<string, PanelController>();
  const debug = { panelReactions: 0 };

  // One producer-agnostic entry point, rather than the job engine reaching into
  // panels. That is what keeps a later cross-tab stage contained to one file.
  const changes = new ChangeNotifier(options.notifications);

  const jobs = new JobsController(commands, resolve, (change) => changes.invalidate(change));
  jobs.activate();

  for (const spec of options.panels) {
    const model = new PanelModel(spec.id, spec.slot, spec.storage, spec.path);
    // The observer registration is a lifetime-bound resource, so it is released
    // on dispose BEFORE `ui:show-panel` settles.
    let unobserve = () => {};
    const controller = new PanelController(
      model,
      resolve(spec.storage),
      commands,
      () => {
        debug.panelReactions++;
      },
      { release: () => unobserve() },
    );
    controllers.set(spec.id, controller);
    await controller.activate();
    unobserve = changes.observe(controller);
  }

  const require = (id: string): PanelController => {
    const c = controllers.get(id);
    if (!c) throw new Error(`Unknown panel: ${id}`);
    return c;
  };

  return {
    panels: {
      get: (id) => require(id).model,
      async remove(id) {
        const controller = require(id);
        controllers.delete(id);
        controller.dispose(); // settles ui:show-panel → the view is removed
        await controller.settled();
      },
    },
    jobs: { get: (id) => jobs.get(id), lastJobId: () => jobs.lastJobId() },
    changes,
    async settled() {
      await changes.settled();
      for (const c of controllers.values()) await c.settled();
      await new Promise((r) => setTimeout(r, 0));
      await changes.settled();
      for (const c of controllers.values()) await c.settled();
    },
    dispose() {
      for (const c of controllers.values()) c.dispose();
      controllers.clear();
      jobs.dispose();
      changes.dispose();
    },
    debug,
  };
}
