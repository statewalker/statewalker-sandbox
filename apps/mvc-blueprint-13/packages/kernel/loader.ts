import type { Context } from "./context.js";
import { type Cleanup, newScope, type Scope } from "./scope.js";
import { getLogger } from "./services.js";

/**
 * Normative: a controller is a function of the context that returns how to tear it down. K: it
 * also receives its bundle scope — what it `defer`s there is disposed when it deactivates, and
 * continuations awaited through `scope.task` are dropped then. Returning a cleanup still works
 * (it is deferred on the scope).
 */
// biome-ignore lint/suspicious/noConfusingVoidType: normative (ARCHITECTURE §8) — an activator may return nothing
export type Controller = (context: Context, scope: Scope) => Promise<void | Cleanup>;
export type Activator = Controller;

/** A bundle's package entry (`"."`): its activator is the default export (P5.3). */
export type BundleModule = { readonly default: Activator };

export interface BundleManifest {
  readonly id: string;
  /**
   * The bundle's entry module: the namespace itself (`import * as m`), or a lazy import
   * (`() => import(…)`). An object is used as-is, a function is awaited — how the code arrives is
   * the loader's business.
   */
  readonly module: BundleModule | (() => Promise<BundleModule>);
  /** Service keys this bundle sets (JupyterLab `provides`). */
  readonly provides?: readonly string[];
  /** Service keys it must resolve (hard: missing ⇒ error before anything activates). */
  readonly requires?: readonly string[];
  /** Service keys it resolves if present. */
  readonly optional?: readonly string[];
}

/** The activator of `bundle`: its module's default export. Throws, naming the bundle, if absent. */
async function activatorOf(bundle: BundleManifest): Promise<Activator> {
  const module = typeof bundle.module === "function" ? await bundle.module() : bundle.module;
  const activator = (module as Partial<BundleModule> | undefined)?.default;
  if (typeof activator !== "function")
    throw new Error(`bundle "${bundle.id}": module has no default export activator`);
  return activator;
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
 * required-first, bundles in listed order, each awaited, each in its own bundle scope; a throwing
 * activator rolls back what already activated (reverse order) and rethrows; the cleanup closes the
 * bundle scopes in reverse, logging a throwing cleanup without stopping the others.
 */
export function application(
  manifest: ApplicationManifest,
): (context: Context, parent?: Scope) => ReturnType<Controller> {
  return async (context, parent) => {
    const bundles = plan(manifest, context);
    const log = getLogger(context).child({ app: manifest.id });
    const app = parent ? parent.child() : newScope();
    const active: { id: string; scope: Scope }[] = [];
    const deactivate = async () => {
      // Bundle scopes close in reverse activation order, one at a time; a throwing cleanup is
      // logged and does not stop the others.
      while (active.length > 0) {
        const { id, scope } = active.pop() as { id: string; scope: Scope };
        try {
          await scope.close();
        } catch (error) {
          log.error("loader:cleanup-failed", { bundle: id, error: String(error) });
        }
      }
      await app.close();
    };
    for (const bundle of bundles) {
      const scope = newScope();
      app.defer(() => scope.close().catch(() => {})); // failures are logged by `deactivate`
      active.push({ id: bundle.id, scope });
      try {
        const activator = await activatorOf(bundle);
        const cleanup = await activator(context, scope);
        if (cleanup) scope.defer(cleanup);
        log.debug("loader:activated", { bundle: bundle.id });
      } catch (error) {
        await deactivate();
        throw error;
      }
    }
    return deactivate;
  };
}
