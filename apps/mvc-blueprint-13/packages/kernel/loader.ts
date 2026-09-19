import type { Context } from "./context.js";
import { getLogger } from "./services.js";

export type Cleanup = () => void | Promise<void>;
/** Normative: a controller is a function of the context that returns how to tear it down. */
// biome-ignore lint/suspicious/noConfusingVoidType: normative (ARCHITECTURE §8) — an activator may return nothing
export type Controller = (context: Context) => Promise<void | Cleanup>;
export type Activator = Controller;

export interface BundleManifest {
  readonly id: string;
  /** A value, or a lazy import — the loader's business. */
  readonly activator: Activator | (() => Promise<Activator>);
  /** Service keys this bundle sets (JupyterLab `provides`). */
  readonly provides?: readonly string[];
  /** Service keys it must resolve (hard: missing ⇒ error before anything activates). */
  readonly requires?: readonly string[];
  /** Service keys it resolves if present. */
  readonly optional?: readonly string[];
  /** When true, `activator` is the lazy form `() => import(…)`. */
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

/** Features in activation order: required first. Throws on a missing feature or a cycle. */
export function resolveFeatures(manifest: ApplicationManifest): FeatureManifest[] {
  const byId = new Map(manifest.features.map((f) => [f.id, f]));
  const order: FeatureManifest[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: readonly string[]) => {
    const feature = byId.get(id);
    if (!feature) {
      throw new Error(`${manifest.id}: feature "${path.at(-1)}" requires missing feature "${id}"`);
    }
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting")
      throw new Error(`${manifest.id}: feature cycle ${[...path, id].join(" → ")}`);
    state.set(id, "visiting");
    for (const dep of feature.requires ?? []) visit(dep, [...path, id]);
    state.set(id, "done");
    order.push(feature);
  };
  for (const feature of manifest.features) visit(feature.id, []);
  return order;
}

/**
 * Checks the bundles' service declarations against the activation order, before anything
 * activates: a required key must be set by the host or by an earlier bundle; a provider must not
 * come after a bundle that requires or optionally reads its key (the read-then-set guard would
 * throw at runtime — this finds it statically).
 */
export function checkServices(
  manifest: ApplicationManifest,
  bundles: readonly BundleManifest[],
  context: Context,
): void {
  const providedBy = new Map<string, string>();
  for (const b of bundles) for (const key of b.provides ?? []) providedBy.set(key, b.id);
  const available = new Set<string>();
  const readBy = new Map<string, string>();
  for (const b of bundles) {
    for (const key of b.provides ?? []) {
      const reader = readBy.get(key);
      if (reader && context[key] === undefined) {
        throw new Error(
          `${manifest.id}: "${b.id}" provides ${key} after "${reader}" read it; activate the provider first`,
        );
      }
    }
    for (const key of b.requires ?? []) {
      if (!available.has(key) && context[key] === undefined && !(b.provides ?? []).includes(key)) {
        const provider = providedBy.get(key);
        throw new Error(
          provider
            ? `${manifest.id}: "${b.id}" requires ${key}, provided later by "${provider}"`
            : `${manifest.id}: "${b.id}" requires ${key}, which nothing provides`,
        );
      }
      if (!readBy.has(key)) readBy.set(key, b.id);
    }
    for (const key of b.optional ?? []) if (!readBy.has(key)) readBy.set(key, b.id);
    for (const key of b.provides ?? []) available.add(key);
  }
}

/** The bundles of `manifest` in activation order. Throws before activation on a wiring error. */
export function plan(manifest: ApplicationManifest, context: Context = {}): BundleManifest[] {
  const bundles = resolveFeatures(manifest).flatMap((f) => f.bundles);
  const seen = new Set<string>();
  for (const b of bundles) {
    if (seen.has(b.id)) throw new Error(`${manifest.id}: bundle "${b.id}" listed twice`);
    seen.add(b.id);
  }
  checkServices(manifest, bundles, context);
  return bundles;
}

/**
 * Turns an application manifest into an activator (itself a controller). Features activate
 * required-first, bundles in listed order, each awaited; a throwing activator rolls back what
 * already activated (reverse order) and rethrows; the cleanup deactivates in reverse, logging a
 * throwing cleanup without stopping the others.
 */
export function application(manifest: ApplicationManifest): Controller {
  return async (context) => {
    const bundles = plan(manifest, context);
    const log = getLogger(context).child({ app: manifest.id });
    const cleanups: { id: string; cleanup: Cleanup }[] = [];
    const deactivate = async () => {
      while (cleanups.length > 0) {
        const { id, cleanup } = cleanups.pop() as { id: string; cleanup: Cleanup };
        try {
          await cleanup();
        } catch (error) {
          log.error("loader:cleanup-failed", { bundle: id, error: String(error) });
        }
      }
    };
    for (const bundle of bundles) {
      try {
        const activator = bundle.lazy
          ? await (bundle.activator as () => Promise<Activator>)()
          : (bundle.activator as Activator);
        const cleanup = await activator(context);
        if (cleanup) cleanups.push({ id: bundle.id, cleanup });
        log.debug("loader:activated", { bundle: bundle.id });
      } catch (error) {
        await deactivate();
        throw error;
      }
    }
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      await deactivate();
    };
  };
}

/**
 * A copy of `manifest` without the features in `ids` and every feature that (transitively)
 * requires one of them. Returns the removed ids too.
 */
export function without(
  manifest: ApplicationManifest,
  ...ids: string[]
): { manifest: ApplicationManifest; removed: string[] } {
  const removed = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of manifest.features) {
      if (!removed.has(f.id) && (f.requires ?? []).some((r) => removed.has(r))) {
        removed.add(f.id);
        changed = true;
      }
    }
  }
  return {
    manifest: {
      id: `${manifest.id}-without-${ids.join("+")}`,
      features: manifest.features.filter((f) => !removed.has(f.id)),
    },
    removed: [...removed],
  };
}
