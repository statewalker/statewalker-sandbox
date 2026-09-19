import { newAdapter as newRawAdapter } from "@statewalker/shared-adapters";

/**
 * The one flat context every bundle of an application shares. It carries services, never data;
 * keys are namespaced (`sys:*` for the kernel, `<bundle>:*` for a bundle's services).
 */
export type Context = Record<string, unknown>;

/** Keys read on a context — kept beside it, never in it. */
const reads = new WeakMap<Context, Set<string>>();

function markRead(context: Context, key: string): void {
  let keys = reads.get(context);
  if (!keys) {
    keys = new Set();
    reads.set(context, keys);
  }
  keys.add(key);
}

/** Whether `key` was already read on `context` (by any getter, found or not). */
export function wasRead(context: Context, key: string): boolean {
  return reads.get(context)?.has(key) ?? false;
}

/**
 * Whether `key` holds a value on `context`. Does NOT count as a read: a provider uses it to
 * "set unless the host already has".
 */
export function isProvided(context: Context, key: string): boolean {
  return context[key] !== undefined;
}

export type Getter<T> = (context: Context) => T;
export type OptionalGetter<T> = (context: Context) => T | undefined;
export type Setter<T> = (context: Context, value: T) => void;

export interface Adapter<T> {
  readonly key: string;
  /** Resolves the service (creating it with the factory if there is one); throws if absent. A read. */
  readonly get: Getter<T>;
  /** Resolves the service or `undefined`. Also a read: a later `set` throws. */
  readonly find: OptionalGetter<T>;
  /** Sets the service. Throws if the key was already read on this context (read-then-set). */
  readonly set: Setter<T>;
}

/**
 * An adapter over `@statewalker/shared-adapters` with the read-then-set guard: setting a key
 * that has already been read on that context throws; setting it before anyone read it overrides.
 * No parent chain. Only kernel `sys:*` adapters pass a factory; bundle services are declared
 * (key + type) and set by their provider.
 */
export function newAdapter<T>(key: string, create?: (context: Context) => T): Adapter<T> {
  const [rawGet, rawSet] = newRawAdapter<T, Context>(key, create, () => undefined);
  return Object.freeze({
    key,
    get: (context: Context) => {
      markRead(context, key);
      return rawGet(context);
    },
    find: (context: Context) => {
      markRead(context, key);
      return rawGet(context, true) as T | undefined;
    },
    set: (context: Context, value: T) => {
      if (wasRead(context, key)) {
        throw new Error(`${key} was already read on this context; set it before activation`);
      }
      rawSet(context, value);
    },
  });
}

/**
 * Resolves every dependency in one place, at the top of an activator:
 * `const fields = useFields({ slots: getSlots, log: getLogger }); … const { slots } = fields(ctx)`.
 */
export function useFields<G extends Record<string, Getter<unknown>>>(
  getters: G,
): (context: Context) => { readonly [K in keyof G]: ReturnType<G[K]> } {
  return (context) => {
    const out: Record<string, unknown> = {};
    for (const [name, get] of Object.entries(getters)) out[name] = get(context);
    return Object.freeze(out) as { readonly [K in keyof G]: ReturnType<G[K]> };
  };
}
