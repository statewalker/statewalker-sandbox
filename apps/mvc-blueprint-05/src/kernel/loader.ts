/**
 * Bundles, features, applications and the loader (ARCHITECTURE §4) — kept as P0 defines them.
 * In R1 an activator is not a controller: it only *wires* — registers a slice, effect handlers
 * and derivations with the store — and returns their disposers. All behaviour lives in updates.
 */
import type { Context } from "./context.ts";
import { getLogger } from "./logger.ts";

export type Cleanup = () => void | Promise<void>;
// biome-ignore lint/suspicious/noConfusingVoidType: the normative signature (ARCHITECTURE §8) allows returning nothing.
export type Activator = (context: Context) => Promise<void | Cleanup>;

export interface BundleManifest {
  readonly id: string;
  readonly activator: Activator | (() => Promise<Activator>);
  /** Distinguishes a lazy import from an activator: set when `activator` is a loader thunk. */
  readonly lazy?: boolean;
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

/** Features in activation order: required first. Throws on a missing requirement or a cycle. */
export function resolveFeatures(manifest: ApplicationManifest): FeatureManifest[] {
  const byId = new Map(manifest.features.map((f) => [f.id, f]));
  const order: FeatureManifest[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, from?: string) => {
    const feature = byId.get(id);
    if (!feature) throw new Error(`feature ${id} (required by ${from}) is not in ${manifest.id}`);
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`feature cycle through ${id}`);
    state.set(id, "visiting");
    for (const req of feature.requires ?? []) visit(req, id);
    state.set(id, "done");
    order.push(feature);
  };
  for (const f of manifest.features) visit(f.id);
  return order;
}

/** The application's activator. Rolls back on a failing activator; cleans up in reverse. */
export function application(manifest: ApplicationManifest): Activator {
  return async (context) => {
    const features = resolveFeatures(manifest);
    const log = getLogger(context).child(manifest.id);
    const cleanups: Array<[string, Cleanup]> = [];
    const stop = async () => {
      for (const [id, cleanup] of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          log.error(`cleanup of ${id} threw`, error);
        }
      }
      cleanups.length = 0;
    };
    try {
      for (const feature of features) {
        for (const bundle of feature.bundles) {
          const activate = bundle.lazy
            ? await (bundle.activator as () => Promise<Activator>)()
            : (bundle.activator as Activator);
          const cleanup = await activate(context);
          if (cleanup) cleanups.push([bundle.id, cleanup]);
        }
      }
    } catch (error) {
      await stop();
      throw error;
    }
    return stop;
  };
}

/** Collects disposers; the returned cleanup runs them in reverse. The whole "controller" of R1. */
export function disposers(...list: Array<() => void>): Cleanup {
  return () => {
    for (const d of list.reverse()) d();
  };
}
