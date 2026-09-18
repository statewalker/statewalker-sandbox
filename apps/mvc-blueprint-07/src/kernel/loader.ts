import type { Cleanup, Context, Controller } from "./context.js";
import { getLogger } from "./logger.js";

export interface BundleManifest {
  readonly id: string;
  /** a value, or a lazy import — how the code arrives is the loader's business */
  readonly activator: Controller | { readonly load: () => Promise<Controller> };
}
export interface FeatureManifest {
  readonly id: string;
  readonly requires?: readonly string[];
  readonly bundles: readonly BundleManifest[];
}
export interface ApplicationManifest {
  readonly id: string;
  readonly features: readonly FeatureManifest[];
}

/** Features in dependency order (required first); a missing requirement or a cycle throws. */
export function resolveFeatures(manifest: ApplicationManifest): FeatureManifest[] {
  const byId = new Map(manifest.features.map((f) => [f.id, f]));
  const order: FeatureManifest[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (feature: FeatureManifest, path: string[]) => {
    const s = state.get(feature.id);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`feature cycle: ${[...path, feature.id].join(" → ")}`);
    state.set(feature.id, "visiting");
    for (const id of feature.requires ?? []) {
      const required = byId.get(id);
      if (!required)
        throw new Error(`feature ${feature.id} requires ${id}, which ${manifest.id} lacks`);
      visit(required, [...path, feature.id]);
    }
    state.set(feature.id, "done");
    order.push(feature);
  };
  for (const feature of manifest.features) visit(feature, []);
  return order;
}

/** The application is itself a controller (§4.2), so it can be activated inside another one. */
export function application(manifest: ApplicationManifest): Controller {
  return async (context: Context) => {
    const features = resolveFeatures(manifest);
    const log = getLogger(context).child(manifest.id);
    const cleanups: Array<{ id: string; cleanup: Cleanup }> = [];
    const stop = async () => {
      for (const { id, cleanup } of cleanups.splice(0).reverse()) {
        try {
          await cleanup();
        } catch (error) {
          log.error(`cleanup of ${id} threw`, error);
        }
      }
    };
    try {
      for (const feature of features) {
        for (const bundle of feature.bundles) {
          const activate =
            typeof bundle.activator === "function"
              ? bundle.activator
              : await bundle.activator.load();
          const cleanup = await activate(context);
          if (cleanup) cleanups.push({ id: bundle.id, cleanup });
        }
      }
    } catch (error) {
      await stop();
      throw error;
    }
    return stop;
  };
}
