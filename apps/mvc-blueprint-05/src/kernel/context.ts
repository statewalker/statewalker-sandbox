/**
 * The context: one flat object of shared services, keyed `sys:*` / `<bundle>:*` (ARCHITECTURE §5.1).
 * In R1 the store is the only kernel service a bundle normally reads; the context survives for the
 * store, the logger, and host-injected configuration (an api with a delay, a notification timeout).
 */
export type Context = Record<string, unknown>;
export type Getter<T> = (context: Context) => T;

const reads = new WeakMap<Context, Set<string>>();

function markRead(context: Context, key: string): void {
  let set = reads.get(context);
  if (!set) reads.set(context, (set = new Set()));
  set.add(key);
}

/** Reads `key`; creates it with `create` on first resolution. Marks the key as read. */
export function getKey<T>(context: Context, key: string, create?: (context: Context) => T): T {
  markRead(context, key);
  if (!(key in context)) {
    if (!create) throw new Error(`${key} is not set on the context and has no factory`);
    context[key] = create(context);
  }
  return context[key] as T;
}

/** Sets `key`. Throws if someone already read it: replacing a captured service is a wiring bug. */
export function setKey<T>(context: Context, key: string, value: T): void {
  if (reads.get(context)?.has(key)) {
    throw new Error(`${key} was already read; set it before activation`);
  }
  context[key] = value;
}

/** Whether `key` is set. Does not count as a read. */
export const hasKey = (context: Context, key: string): boolean => key in context;

/** An adapter: a getter (with an optional factory) and a guarded setter for one key. */
export function newAdapter<T>(
  key: string,
  create?: (context: Context) => T,
): [get: Getter<T>, set: (context: Context, value: T) => void] {
  return [
    (context) => getKey(context, key, create),
    (context, value) => setKey(context, key, value),
  ];
}

/** Resolves every dependency in one place (the top of an activator). */
export function useFields<G extends Record<string, Getter<unknown>>>(
  getters: G,
): (context: Context) => { readonly [K in keyof G]: ReturnType<G[K]> } {
  return (context) => {
    const out: Record<string, unknown> = {};
    for (const [name, get] of Object.entries(getters)) out[name] = get(context);
    return out as { readonly [K in keyof G]: ReturnType<G[K]> };
  };
}
