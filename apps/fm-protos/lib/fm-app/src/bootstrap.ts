import type { Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import { JobsController } from "./jobs-controller.js";
import { PanelController } from "./panel-controller.js";
import { PanelModel } from "./panel-model.js";
import type { JobModel } from "@fm/core";

export interface BootstrapPanelSpec {
  id: string;
  slot: string;
  storage: string;
  path: string;
}

export interface BootstrapOptions {
  commands: Commands;
  storages: Record<string, FilesApi>;
  panels: BootstrapPanelSpec[];
}

export interface App {
  panels: { get(id: string): PanelModel; remove(id: string): Promise<void> };
  jobs: { get(id: string): JobModel; lastJobId(): string | undefined };
  settled(): Promise<void>;
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

  const jobs = new JobsController(commands, resolve, (storage, path) => {
    for (const controller of controllers.values()) controller.invalidate(storage, path);
  });
  jobs.activate();

  for (const spec of options.panels) {
    const model = new PanelModel(spec.id, spec.slot, spec.storage, spec.path);
    const controller = new PanelController(model, resolve(spec.storage), commands, () => {
      debug.panelReactions++;
    });
    controllers.set(spec.id, controller);
    await controller.activate();
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
    async settled() {
      for (const c of controllers.values()) await c.settled();
      await new Promise((r) => setTimeout(r, 0));
      for (const c of controllers.values()) await c.settled();
    },
    debug,
  };
}
