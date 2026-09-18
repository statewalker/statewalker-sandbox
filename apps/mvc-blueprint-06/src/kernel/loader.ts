/**
 * Bundles, features, applications — ARCHITECTURE.md §4 with "activate" = spawn an actor.
 *
 * A bundle IS an actor: its id is its address. Configuration (an injected api, a timeout, a DOM
 * root) travels in the manifest, by value — there is no context to put it in.
 */
import type { ActorSystem, Behavior } from "./actors.js";

export interface BundleManifest {
  readonly id: string;
  /** The actor, or how to load it (a lazy `import()`); how code arrives is the loader's concern. */
  // biome-ignore lint/suspicious/noExplicitAny: a manifest list holds actors of every message type
  readonly behavior: Behavior<any> | { readonly load: () => Promise<Behavior<any>> };
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

export type Cleanup = () => Promise<void>;
export type Activator = (system: ActorSystem) => Promise<Cleanup>;

/** Features in dependency order; a missing requirement or a cycle throws before anything runs. */
export function resolveFeatures(manifest: ApplicationManifest): FeatureManifest[] {
  const byId = new Map(manifest.features.map((f) => [f.id, f]));
  const ordered: FeatureManifest[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, from?: string) => {
    const f = byId.get(id);
    if (!f) throw new Error(`feature "${from}" requires "${id}", which is not in "${manifest.id}"`);
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") throw new Error(`feature cycle through "${id}"`);
    state.set(id, "visiting");
    for (const r of f.requires ?? []) visit(r, id);
    state.set(id, "done");
    ordered.push(f);
  };
  for (const f of manifest.features) visit(f.id);
  return ordered;
}

/** The application without `featureId` and every feature that (transitively) requires it. */
export function without(
  manifest: ApplicationManifest,
  featureId: string,
): { manifest: ApplicationManifest; dropped: string[] } {
  const dropped = new Set([featureId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of manifest.features) {
      if (!dropped.has(f.id) && (f.requires ?? []).some((r) => dropped.has(r))) {
        dropped.add(f.id);
        grew = true;
      }
    }
  }
  return {
    manifest: {
      id: `${manifest.id}-without-${featureId}`,
      features: manifest.features.filter((f) => !dropped.has(f.id)),
    },
    dropped: [...dropped],
  };
}

export function application(manifest: ApplicationManifest): Activator {
  return async (system) => {
    const features = resolveFeatures(manifest);
    const started: string[] = [];
    const stopAll = async () => {
      for (const id of started.splice(0).reverse()) {
        try {
          system.stop(id);
        } catch (error) {
          system.log.error(`stopping "${id}" threw`, error);
        }
      }
    };
    try {
      for (const f of features) {
        for (const b of f.bundles) {
          const behavior = await resolveBehavior(b);
          system.spawn(b.id, behavior);
          started.push(b.id);
        }
      }
    } catch (error) {
      await stopAll();
      throw error;
    }
    return stopAll;
  };
}

async function resolveBehavior(b: BundleManifest): Promise<Behavior<unknown>> {
  return typeof b.behavior === "function" ? b.behavior : b.behavior.load();
}
