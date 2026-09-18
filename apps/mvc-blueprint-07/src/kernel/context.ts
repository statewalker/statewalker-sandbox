/**
 * Context + adapters (ARCHITECTURE §5.1). One flat object per application; keys are namespaced
 * (`sys:*` for the kernel, `<bundle>:*` for bundle services). Private state never lives here.
 */
export type Context = Record<string, unknown>;
export type Cleanup = () => void | Promise<void>;
/** Normative (§8): a controller — here, a bundle activator — sets things up and returns its teardown. */
// biome-ignore lint/suspicious/noConfusingVoidType: the normative signature (§8) — a controller may return nothing
export type Controller = (context: Context) => Promise<void | Cleanup>;

/** The read set lives beside the context, not in it. */
const reads = new WeakMap<Context, Set<string>>();

export type Getter<T> = (context: Context) => T;
export type Setter<T> = (context: Context, value: T) => void;

/**
 * A service key. With a factory the first read creates the value (kernel services: a bundle can run
 * on `{}`); without one an unset read throws. Setting a key that was already read throws.
 */
export function defineService<T>(
  key: string,
  create?: (context: Context) => T,
): [get: Getter<T>, set: Setter<T>, has: (context: Context) => boolean] {
  const get: Getter<T> = (context) => {
    const seen = reads.get(context) ?? new Set<string>();
    reads.set(context, seen);
    seen.add(key);
    if (!(key in context)) {
      if (!create) throw new Error(`${key} is not provided`);
      context[key] = create(context);
    }
    return context[key] as T;
  };
  const set: Setter<T> = (context, value) => {
    if (reads.get(context)?.has(key)) {
      throw new Error(`${key} was already read; set it before activation`);
    }
    context[key] = value;
  };
  const has = (context: Context) => key in context;
  return [get, set, has];
}

/** Resolve every dependency in one place, at the top of an activator. */
export function useFields<G extends Record<string, Getter<unknown>>>(
  getters: G,
): (context: Context) => { readonly [K in keyof G]: ReturnType<G[K]> } {
  return (context) => {
    const out: Record<string, unknown> = {};
    for (const [name, getter] of Object.entries(getters)) out[name] = getter(context);
    return out as { readonly [K in keyof G]: ReturnType<G[K]> };
  };
}
