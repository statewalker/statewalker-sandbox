/**
 * The store — R1's whole kernel beyond the context.
 *
 * One state tree per application, split into **slices**. A slice is registered by exactly one
 * bundle and written only by that bundle's pure `update(state, msg, env)`: the store computes
 * `root[slice.id] = slice.update(root[slice.id], msg)` and nothing else can reach the key.
 *
 * Four extension points, all keyed and all withdrawn by a disposer:
 *   - slices           update functions (+ init, + subscriptions) — who may write what;
 *   - effect handlers  who performs an effect *value* an update returned (IO, api calls);
 *   - sub handlers     who runs a subscription *value* (timers);
 *   - points           derivations `state → contributions` — the published views.
 *
 * Messages are processed one at a time (a queue drained synchronously), so an update always reads
 * the state as of its message: commit-time semantics by construction.
 */
import type { Logger } from "./logger.ts";

export interface Msg {
  readonly type: string;
}
/** An effect is data an update returns; a handler registered for its `type` performs it. */
export interface Effect {
  readonly type: string;
}
/** A subscription is data a slice declares from its state; the store diffs them by `key`. */
export interface Sub {
  readonly type: string;
  readonly key: string;
}
/** An extension point: a typed id. Contributions to it are derived from state. */
export interface Point<T> {
  readonly id: string;
  /** Phantom: carries the contribution type. */
  readonly _contribution?: T;
}
export const definePoint = <T>(id: string): Point<T> => ({ id });

/** Reads a point's current contributions (over the state the caller is looking at). */
export type Select = <T>(point: Point<T>) => readonly T[];

const NEXT: unique symbol = Symbol("next");
/** An update's result when it also returns effects. */
export interface Next<S> {
  readonly [NEXT]: true;
  readonly state: S;
  readonly effects: readonly Effect[];
}
export const next = <S>(state: S, ...effects: Effect[]): Next<S> => ({
  [NEXT]: true,
  state,
  effects,
});
const isNext = (value: unknown): value is Next<unknown> =>
  typeof value === "object" && value !== null && NEXT in value;

/** The built-in effect: dispatch a message after the current one (how updates talk to each other). */
export interface DispatchEffect extends Effect {
  readonly type: "sys/dispatch";
  readonly msg: Msg;
}
export const dispatchFx = (msg: Msg): DispatchEffect => ({ type: "sys/dispatch", msg });

/** The built-in subscription: dispatch `msg` once, `ms` after the key first appears. */
export interface AfterSub extends Sub {
  readonly type: "sys/after";
  readonly ms: number;
  readonly msg: Msg;
}
export const afterSub = (key: string, ms: number, msg: Msg): AfterSub => ({
  type: "sys/after",
  key,
  ms,
  msg,
});

export interface UpdateEnv {
  /** Points evaluated over the state *before* this message — what the user saw when committing. */
  readonly select: Select;
}
export interface SliceDef<S> {
  /** The only key of the state tree this slice writes. Conventionally the bundle id. */
  readonly id: string;
  init(env: UpdateEnv): S | Next<S>;
  /** Pure. Sees every message; returns its state unchanged for the ones it ignores. */
  update(state: S, msg: Msg, env: UpdateEnv): S | Next<S>;
  subscriptions?(state: S): readonly Sub[];
}
export interface SliceHandle<S> {
  /** Contributes a derivation of this slice's state to a point; withdrawn with the slice. */
  contribute<T>(
    point: Point<T>,
    key: string,
    derive: (state: S, select: Select) => readonly T[],
  ): () => void;
  /** Removes the slice: its key leaves the state, its effects are aborted, its subs stopped. */
  dispose(): void;
}

export interface EffectIO {
  /** Dropped (and logged at debug) once the effect is aborted. */
  dispatch(msg: Msg): void;
  readonly signal: AbortSignal;
  readonly select: Select;
}
export type EffectHandler<E extends Effect> = (effect: E, io: EffectIO) => void | Promise<void>;
export type SubHandler<S extends Sub> = (sub: S, dispatch: (msg: Msg) => void) => () => void;

export interface Coverage {
  /** Messages no update acted on (no state change, no effect): a missing or removed receiver. */
  readonly idleMessages: readonly string[];
  /** Effects dispatched with no handler — a wiring error, also logged at error level. */
  readonly unhandledEffects: readonly string[];
  /** Points with contributions that nobody has selected since they changed. */
  readonly unreadPoints: readonly string[];
}
export interface StoreInspection {
  readonly slices: readonly string[];
  readonly contributions: number;
  readonly effectHandlers: number;
  readonly effectsInFlight: number;
  readonly subscriptions: number;
  readonly listeners: number;
}

export interface Store {
  getState(): Readonly<Record<string, unknown>>;
  /** Called once per processed message that changed the state, and once per registry change. */
  subscribe(listener: () => void): () => void;
  dispatch(msg: Msg): void;
  select: Select;
  addSlice<S>(def: SliceDef<S>): SliceHandle<S>;
  /** A derivation that reads no slice (renderers, pure compositions of other points). */
  contribute<T>(point: Point<T>, key: string, derive: (select: Select) => readonly T[]): () => void;
  addEffectHandler<E extends Effect>(type: E["type"], handler: EffectHandler<E>): () => void;
  addSubHandler<S extends Sub>(type: S["type"], handler: SubHandler<S>): () => void;
  coverage(): Coverage;
  inspect(): StoreInspection;
  dispose(): void;
}

interface SliceEntry {
  def: SliceDef<unknown>;
  running: Map<string, () => void>; // sub key → stop
  inFlight: Set<AbortController>;
}
interface Contribution {
  point: string;
  key: string;
  derive: (select: Select) => readonly unknown[];
}

export function createStore(log: Logger): Store {
  let root: Readonly<Record<string, unknown>> = Object.freeze({});
  let registryVersion = 0;
  let disposed = false;
  let draining = false;
  const queue: Msg[] = [];
  const listeners = new Set<() => void>();
  const slices = new Map<string, SliceEntry>();
  const contributions = new Map<string, Contribution>(); // `${point}::${key}`
  const effectHandlers = new Map<string, EffectHandler<Effect>>();
  const byHandler = new Map<string, Set<AbortController>>(); // effect type → in flight
  const subHandlers = new Map<string, SubHandler<Sub>>();
  const idle = new Set<string>();
  const unhandledEffects = new Set<string>();
  const unread = new Set<string>();

  // ---- select: memoised per (root, registry version) --------------------------------------------
  let memoRoot = root;
  let memoVersion = registryVersion;
  const memo = new Map<string, readonly unknown[]>();
  const evaluating = new Set<string>();
  const select: Select = <T>(point: Point<T>): readonly T[] => {
    if (memoRoot !== root || memoVersion !== registryVersion) {
      memo.clear();
      memoRoot = root;
      memoVersion = registryVersion;
    }
    unread.delete(point.id);
    const cached = memo.get(point.id);
    if (cached) return cached as readonly T[];
    if (evaluating.has(point.id)) throw new Error(`cycle while deriving point ${point.id}`);
    evaluating.add(point.id);
    const out: unknown[] = [];
    try {
      for (const c of contributions.values()) {
        if (c.point !== point.id) continue;
        try {
          out.push(...c.derive(select));
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("cycle")) throw error;
          log.error(`derivation ${c.key} → ${point.id} threw`, error);
        }
      }
    } finally {
      evaluating.delete(point.id);
    }
    const frozen = Object.freeze(out);
    memo.set(point.id, frozen);
    return frozen as readonly T[];
  };
  const env: UpdateEnv = { select };

  // ---- notification ------------------------------------------------------------------------------
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log.error("store listener threw", error);
      }
    }
  };
  const registryChanged = (point?: string) => {
    registryVersion++;
    if (point) unread.add(point);
    notify();
  };

  // ---- effects -----------------------------------------------------------------------------------
  const runEffect = (owner: Set<AbortController>, effect: Effect) => {
    if (effect.type === "sys/dispatch") {
      enqueue((effect as DispatchEffect).msg);
      return;
    }
    const handler = effectHandlers.get(effect.type);
    if (!handler) {
      unhandledEffects.add(effect.type);
      log.error(`no handler for effect ${effect.type}`);
      return;
    }
    const controller = new AbortController();
    owner.add(controller);
    const handlerSet = byHandler.get(effect.type) ?? new Set();
    byHandler.set(effect.type, handlerSet);
    handlerSet.add(controller);
    const io: EffectIO = {
      signal: controller.signal,
      select,
      dispatch(msg) {
        if (controller.signal.aborted || disposed) {
          log.debug(`dropped ${msg.type}: its effect ${effect.type} was aborted`);
          return;
        }
        enqueue(msg);
      },
    };
    const done = () => {
      owner.delete(controller);
      handlerSet.delete(controller);
    };
    try {
      const result = handler(effect, io);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).then(done, (error) => {
          done();
          if (!controller.signal.aborted) log.error(`effect ${effect.type} failed`, error);
        });
      } else done();
    } catch (error) {
      done();
      log.error(`effect ${effect.type} threw`, error);
    }
  };

  // ---- subscriptions -----------------------------------------------------------------------------
  const syncSubs = (entry: SliceEntry) => {
    const def = entry.def;
    if (!def.subscriptions) return;
    const state = root[def.id];
    let wanted: readonly Sub[] = [];
    if (def.id in root) {
      try {
        wanted = def.subscriptions(state);
      } catch (error) {
        log.error(`subscriptions of ${def.id} threw`, error);
      }
    }
    const keys = new Set(wanted.map((s) => s.key));
    for (const [key, stop] of entry.running) {
      if (!keys.has(key)) {
        entry.running.delete(key);
        stop();
      }
    }
    for (const sub of wanted) {
      if (entry.running.has(sub.key)) continue;
      const handler = subHandlers.get(sub.type);
      if (!handler) {
        log.error(`no handler for subscription ${sub.type}`);
        continue;
      }
      let live = true;
      const stop = handler(sub, (msg) => {
        if (live && !disposed) enqueue(msg);
      });
      entry.running.set(sub.key, () => {
        live = false;
        stop();
      });
    }
  };

  // ---- the step ----------------------------------------------------------------------------------
  const step = (msg: Msg) => {
    const prev = root;
    let changed: Record<string, unknown> | undefined;
    const effects: Array<[SliceEntry, Effect]> = [];
    for (const entry of slices.values()) {
      const { id } = entry.def;
      const before = prev[id];
      let result: unknown;
      try {
        result = entry.def.update(before, msg, env);
      } catch (error) {
        log.error(`update of ${id} threw on ${msg.type}`, error);
        continue;
      }
      const state = isNext(result) ? result.state : result;
      if (isNext(result)) for (const fx of result.effects) effects.push([entry, fx]);
      if (state !== before) {
        changed ??= { ...prev };
        changed[id] = deepFreeze(state);
      }
    }
    if (!changed && effects.length === 0) {
      idle.add(msg.type);
      log.debug(`no update acted on ${msg.type}`);
    }
    if (changed) {
      root = Object.freeze(changed);
      for (const entry of slices.values()) syncSubs(entry);
      notify();
    }
    for (const [entry, fx] of effects) runEffect(entry.inFlight, fx);
  };

  const enqueue = (msg: Msg) => {
    if (disposed) return;
    queue.push(msg);
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !disposed) step(queue.shift() as Msg);
    } finally {
      draining = false;
    }
  };

  const removeSlice = (entry: SliceEntry) => {
    const { id } = entry.def;
    if (slices.get(id) !== entry) return;
    slices.delete(id);
    for (const c of entry.inFlight) c.abort();
    entry.inFlight.clear();
    for (const stop of entry.running.values()) stop();
    entry.running.clear();
    const rest = { ...root };
    delete rest[id];
    root = Object.freeze(rest);
    notify();
  };

  const addContribution = (
    point: Point<unknown>,
    key: string,
    derive: (select: Select) => readonly unknown[],
  ) => {
    const id = `${point.id}::${key}`;
    if (contributions.has(id)) throw new Error(`${point.id} already has a contribution "${key}"`);
    const c: Contribution = { point: point.id, key, derive };
    contributions.set(id, c);
    registryChanged(point.id);
    return () => {
      if (contributions.get(id) !== c) return;
      contributions.delete(id);
      registryChanged();
    };
  };

  // Built-in subscription kind: a one-shot timer.
  subHandlers.set("sys/after", ((sub: AfterSub, dispatch) => {
    const timer = setTimeout(() => dispatch(sub.msg), sub.ms);
    return () => clearTimeout(timer);
  }) as SubHandler<Sub>);

  return {
    getState: () => root,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: enqueue,
    select,
    addSlice<S>(def: SliceDef<S>): SliceHandle<S> {
      if (disposed) throw new Error("the store is disposed");
      if (slices.has(def.id)) throw new Error(`slice ${def.id} already has a writer`);
      const entry: SliceEntry = {
        def: def as SliceDef<unknown>,
        running: new Map(),
        inFlight: new Set(),
      };
      const init = def.init(env);
      const state = isNext(init) ? init.state : init;
      slices.set(def.id, entry);
      root = Object.freeze({ ...root, [def.id]: deepFreeze(state) });
      syncSubs(entry);
      const owned = new Set<() => void>();
      notify();
      if (isNext(init)) for (const fx of init.effects) runEffect(entry.inFlight, fx);
      return {
        contribute<T>(
          point: Point<T>,
          key: string,
          derive: (state: S, select: Select) => readonly T[],
        ) {
          const withdraw = addContribution(point as Point<unknown>, key, (sel) =>
            def.id in root ? derive(root[def.id] as S, sel) : [],
          );
          owned.add(withdraw);
          return () => {
            owned.delete(withdraw);
            withdraw();
          };
        },
        dispose() {
          for (const withdraw of [...owned].reverse()) withdraw();
          owned.clear();
          removeSlice(entry);
        },
      };
    },
    contribute: (point, key, derive) =>
      addContribution(point as Point<unknown>, key, derive as (s: Select) => readonly unknown[]),
    addEffectHandler(type, handler) {
      if (effectHandlers.has(type)) throw new Error(`effect ${type} already has a handler`);
      effectHandlers.set(type, handler as EffectHandler<Effect>);
      return () => {
        if (effectHandlers.get(type) !== (handler as EffectHandler<Effect>)) return;
        effectHandlers.delete(type);
        // Its owner is leaving: whatever it still has in flight must not write back.
        for (const c of byHandler.get(type) ?? []) c.abort();
        byHandler.delete(type);
      };
    },
    addSubHandler(type, handler) {
      if (subHandlers.has(type)) throw new Error(`subscription ${type} already has a handler`);
      subHandlers.set(type, handler as SubHandler<Sub>);
      return () => {
        subHandlers.delete(type);
      };
    },
    coverage: () => ({
      idleMessages: [...idle],
      unhandledEffects: [...unhandledEffects],
      unreadPoints: [...unread].filter((p) =>
        [...contributions.values()].some((c) => c.point === p),
      ),
    }),
    inspect: () => ({
      slices: [...slices.keys()],
      contributions: contributions.size,
      effectHandlers: effectHandlers.size,
      effectsInFlight: [...slices.values()].reduce((n, e) => n + e.inFlight.size, 0),
      subscriptions: [...slices.values()].reduce((n, e) => n + e.running.size, 0),
      listeners: listeners.size,
    }),
    dispose() {
      if (disposed) return;
      for (const entry of [...slices.values()].reverse()) removeSlice(entry);
      disposed = true;
      contributions.clear();
      effectHandlers.clear();
      listeners.clear();
      queue.length = 0;
    },
  };
}

/** Freezes a committed state deeply, so neither a view nor another update can write it in place. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
