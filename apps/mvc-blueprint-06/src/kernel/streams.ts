/**
 * State streams — the only way state leaves an actor.
 *
 * A stream is a named, retained value with exactly one owner (an actor address). The owner
 * publishes whole values; anyone may read the current value or subscribe. It is the actor
 * counterpart of a single-contribution slot + an observable model, collapsed into one thing.
 *
 * Contract (MODELS.md §4 mapped onto streams, pinned by tests/contract):
 *  1. `subscribe(cb)` calls back immediately, before returning.
 *  2. One notification per publish.
 *  3. A publish shallow-equal to the held value notifies nobody and keeps the old reference.
 *  4. Notifications are delivered in order, synchronously, before `publish` returns.
 *  5. Unsubscribing inside a callback is safe and final; a subscriber removed earlier in the pass
 *     is not woken.
 *  6. A throwing subscriber never reaches the publisher and never stops the others; the error goes
 *     to `onError` (out of band).
 *  7. A value keeps its reference identity until it changes.
 *  8. When the owner releases the stream (it stopped), the value becomes `undefined` — the stream
 *     is *absent*, like a withdrawn slot contribution — and a new owner may claim the key.
 *  9. A publish replaces the whole value; there is no patch.
 */

/** A stream key carries its value type. Declared in API modules. */
export type StreamKey<S> = string & { readonly __stream?: S };
export const defineStream = <S>(key: string): StreamKey<S> => key as StreamKey<S>;

export type Listener = () => void;

/** What a view (or a test) may do with streams: read and subscribe. No writer. */
export interface StreamReader {
  get<S>(key: StreamKey<S>): S | undefined;
  subscribe<S>(key: StreamKey<S>, listener: Listener): () => void;
}

interface Entry {
  owner: string | undefined;
  value: unknown;
  listeners: Set<Listener>;
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false;
  }
  return true;
}

/**
 * Value equality for plain data (what crosses a mailbox). Messages carry copies, not identities, so
 * "did it change?" must be asked by value — or an owner and a contributor that re-send on every
 * change ping-pong forever.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export class StreamHub implements StreamReader {
  readonly #entries = new Map<string, Entry>();
  constructor(private readonly onError: (key: string, error: unknown) => void) {}

  #entry(key: string): Entry {
    let e = this.#entries.get(key);
    if (!e) {
      e = { owner: undefined, value: undefined, listeners: new Set() };
      this.#entries.set(key, e);
    }
    return e;
  }

  get<S>(key: StreamKey<S>): S | undefined {
    return this.#entries.get(key)?.value as S | undefined;
  }

  ownerOf(key: string): string | undefined {
    return this.#entries.get(key)?.owner;
  }

  subscribe<S>(key: StreamKey<S>, listener: Listener): () => void {
    const e = this.#entry(key);
    // A distinct wrapper per subscription, so the same function subscribed twice is two subscriptions.
    const wrapped: Listener = () => listener();
    e.listeners.add(wrapped);
    this.#call(key, wrapped);
    return () => {
      e.listeners.delete(wrapped);
    };
  }

  /** Publish as `owner`. The first publish claims the key; a second owner throws. */
  publish<S>(key: StreamKey<S>, owner: string, value: S): void {
    const e = this.#entry(key);
    if (e.owner !== undefined && e.owner !== owner) {
      throw new Error(`stream "${key}" is owned by "${e.owner}"; "${owner}" may not publish it`);
    }
    e.owner = owner;
    if (shallowEqual(e.value, value)) return;
    e.value = value;
    this.#notify(key, e);
  }

  /** The owner stopped: the stream becomes absent and the key free. */
  release(key: string, owner: string): void {
    const e = this.#entries.get(key);
    if (!e || e.owner !== owner) return;
    e.owner = undefined;
    if (e.value === undefined) return;
    e.value = undefined;
    this.#notify(key, e);
  }

  #notify(key: string, e: Entry): void {
    for (const l of [...e.listeners]) {
      if (e.listeners.has(l)) this.#call(key, l);
    }
  }

  #call(key: string, l: Listener): void {
    try {
      l();
    } catch (error) {
      this.onError(key, error);
    }
  }

  /** Diagnostics: keys that have a value or an owner, and listener counts. */
  snapshot(): { key: string; owner?: string; hasValue: boolean; listeners: number }[] {
    return [...this.#entries].map(([key, e]) => ({
      key,
      owner: e.owner,
      hasValue: e.value !== undefined,
      listeners: e.listeners.size,
    }));
  }
}
