import { defineService } from "./context.js";
import { getLogger, type Logger } from "./logger.js";

/**
 * The intent log — R3's replacement for commands (§5.3) and for action submit edges (§7.1).
 *
 * - An **intent** is a named type plus a captured, frozen payload, appended as a record. The record
 *   IS the commit: whatever it carries was captured at append time, so nothing re-reads a form.
 * - An intent type has at most **one handler** (its reactor). The handler's return value — or its
 *   throw — becomes an **outcome record** appended by the log itself. Nobody reports errors by hand.
 * - Any number of **projections** fold every record, in log order. A projection may write its own
 *   models and slots but may never append: side effects belong to handlers.
 * - Records are dispatched strictly in `seq` order: an append made while another record is being
 *   dispatched is queued and delivered after it, to everyone, before the outer `append` returns.
 */
export type Policy =
  /** a handler must exist when the record is dispatched; none → a failed outcome and an error log */
  | "required"
  /** no handler → an immediate ok outcome */
  | "optional"
  /** an event: folded by projections, never answered, no outcome */
  | "none";

export interface IntentType<P, R = void> {
  readonly id: string;
  readonly policy: Policy;
  /** Phantom fields carrying the payload and result types. Never read at runtime. */
  readonly _payload?: P;
  readonly _result?: R;
}

export function defineIntent<P = void, R = void>(
  id: string,
  policy: "required" | "optional" = "required",
): IntentType<P, R> {
  return Object.freeze({ id, policy });
}

/** An intent no one answers: a projection-only input (a selection change, a counter bump). */
export function defineEvent<P = void>(id: string): IntentType<P, never> {
  return Object.freeze({ id, policy: "none" as const });
}

export interface IntentRecord<P = unknown> {
  readonly kind: "intent";
  readonly seq: number;
  readonly type: string;
  readonly payload: P;
  /** the scope (bundle) that appended it */
  readonly origin: string;
  /** the record this one was appended in answer to, if any */
  readonly cause?: number;
}

export interface OutcomeRecord<R = unknown> {
  readonly kind: "outcome";
  readonly seq: number;
  /** the answered intent's type */
  readonly type: string;
  /** the answered intent's seq */
  readonly cause: number;
  readonly ok: boolean;
  readonly value?: R;
  readonly error?: string;
  /** the handler's scope, or "sys:log" for outcomes the log writes itself */
  readonly origin: string;
}

export type LogRecord = IntentRecord | OutcomeRecord;

export const isIntent = <P, R>(
  record: LogRecord,
  type: IntentType<P, R>,
): record is IntentRecord<P> => record.kind === "intent" && record.type === type.id;

export const isOutcome = <P, R>(
  record: LogRecord,
  type: IntentType<P, R>,
): record is OutcomeRecord<R> => record.kind === "outcome" && record.type === type.id;

export class IntentError extends Error {
  constructor(readonly outcome: OutcomeRecord) {
    super(outcome.error ?? "failed");
  }
}

/** What a bundle holds: the log, bound to its origin, closed by the bundle's cleanup. */
export interface IntentLog {
  readonly origin: string;
  readonly closed: boolean;
  append<P, R>(type: IntentType<P, R>, payload: P, options?: { cause?: number }): IntentRecord<P>;
  /** append, then wait for the outcome: resolves with the handler's value, rejects with IntentError */
  request<P, R>(type: IntentType<P, R>, payload: P, options?: { cause?: number }): Promise<R>;
  outcome<R = unknown>(record: IntentRecord): Promise<R>;
  /** the one reactor for `type`; a second handler for the same type throws */
  handle<P, R>(
    type: IntentType<P, R>,
    handler: (record: IntentRecord<P>) => R | Promise<R>,
  ): () => void;
  /** a pure fold over every record; `replay` first delivers the retained records already dispatched */
  project(fold: (record: LogRecord) => void, options?: { replay?: boolean }): () => void;
  /** retained records appended after `seq` (optimistic-concurrency checks in multi-step handlers) */
  since(seq: number): readonly LogRecord[];
  isPending(seq: number): boolean;
  /** unregister this scope's handlers and projections, fail its in-flight intents, refuse appends */
  close(): void;
}

export interface LogStats {
  readonly appended: number;
  readonly retained: number;
  readonly pending: number;
  readonly handlers: number;
  readonly projections: number;
  readonly openScopes: readonly string[];
}

export interface IntentLogCore {
  open(origin: string): IntentLog;
  records(): readonly LogRecord[];
  stats(): LogStats;
  /** drop settled records beyond the newest `keep`; pending intents are never dropped */
  compact(keep: number): number;
  /** resolves when no answered intent is pending */
  idle(): Promise<void>;
}

interface Scope {
  readonly origin: string;
  closed: boolean;
}

interface Pending {
  readonly record: IntentRecord;
  scope?: Scope;
}

const LOG: Scope = { origin: "sys:log", closed: false };

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) freezeDeep(inner);
  }
  return value;
}
/** Records are data: cloned (so a later mutation of the source cannot reach them) and frozen. */
const capture = <T>(value: T): T =>
  value === undefined ? value : freezeDeep(structuredClone(value));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createIntentLog(options: { logger?: Logger; retain?: number } = {}): IntentLogCore {
  const logger = options.logger;
  const retain = options.retain ?? Number.POSITIVE_INFINITY;
  let seq = 0;
  let appended = 0;
  let records: LogRecord[] = [];
  const outcomes = new Map<number, OutcomeRecord>();
  const pending = new Map<number, Pending>();
  const waiters = new Map<number, Array<(outcome: OutcomeRecord) => void>>();
  const idleWaiters: Array<() => void> = [];
  const policies = new Map<string, Policy>();
  const handlers = new Map<string, { scope: Scope; fn: (record: IntentRecord) => unknown }>();
  let projections: Array<{ scope: Scope; fn: (record: LogRecord) => void }> = [];
  const scopes = new Set<Scope>();
  const queue: LogRecord[] = [];
  let draining = false;
  let inProjection = 0;
  let dispatchedUpTo = 0;

  const policyOf = (type: IntentType<unknown, unknown>) => {
    const known = policies.get(type.id);
    if (known && known !== type.policy) {
      throw new Error(`${type.id} is declared twice with different policies`);
    }
    policies.set(type.id, type.policy);
    return type.policy;
  };

  const enqueue = (record: LogRecord) => {
    records.push(record);
    queue.push(record);
    appended++;
    if (draining) return;
    draining = true;
    try {
      for (let next = queue.shift(); next; next = queue.shift()) dispatch(next);
    } finally {
      draining = false;
    }
    if (records.length > retain * 2) compact(retain);
    if (pending.size === 0) for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const settle = (entry: Pending, ok: boolean, result: unknown, origin: string) => {
    const { record } = entry;
    if (pending.get(record.seq) !== entry) return; // already settled (e.g. its scope stopped)
    pending.delete(record.seq);
    const outcome: OutcomeRecord = Object.freeze({
      kind: "outcome",
      seq: ++seq,
      type: record.type,
      cause: record.seq,
      ok,
      ...(ok ? { value: capture(result) } : { error: messageOf(result) }),
      origin,
    });
    outcomes.set(record.seq, outcome);
    enqueue(outcome);
  };

  const dispatch = (record: LogRecord) => {
    dispatchedUpTo = record.seq;
    for (const projection of projections) {
      if (projection.scope.closed) continue;
      inProjection++;
      try {
        projection.fn(record);
      } catch (error) {
        logger?.error(`projection of ${projection.scope.origin} threw on ${record.type}`, error);
      } finally {
        inProjection--;
      }
    }
    if (record.kind === "outcome") {
      for (const resolve of waiters.get(record.cause) ?? []) resolve(record);
      waiters.delete(record.cause);
      return;
    }
    const entry = pending.get(record.seq);
    if (!entry) return; // an event, or already settled
    const handler = handlers.get(record.type);
    if (!handler) {
      if (policies.get(record.type) === "required") {
        logger?.error(`no handler for required intent ${record.type} (from ${record.origin})`);
        settle(entry, false, new Error(`no handler for ${record.type}`), LOG.origin);
      } else settle(entry, true, undefined, LOG.origin);
      return;
    }
    entry.scope = handler.scope;
    let result: unknown;
    try {
      result = handler.fn(record);
    } catch (error) {
      settle(entry, false, error, handler.scope.origin);
      return;
    }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(
        (value) => !handler.scope.closed && settle(entry, true, value, handler.scope.origin),
        (error) => !handler.scope.closed && settle(entry, false, error, handler.scope.origin),
      );
    } else settle(entry, true, result, handler.scope.origin);
  };

  const outcome = <R>(record: IntentRecord): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const done = (o: OutcomeRecord) =>
        o.ok ? resolve(o.value as R) : reject(new IntentError(o));
      const known = outcomes.get(record.seq);
      if (known) return done(known);
      if (!pending.has(record.seq)) {
        return reject(new Error(`${record.type}#${record.seq} has no outcome to wait for`));
      }
      const list = waiters.get(record.seq) ?? [];
      list.push(done);
      waiters.set(record.seq, list);
    });

  const compact = (keep: number): number => {
    const excess = records.length - keep;
    if (excess <= 0) return 0;
    let dropped = 0;
    const kept: LogRecord[] = [];
    for (const record of records) {
      const droppable = !pending.has(record.seq) && !queue.includes(record);
      if (droppable && dropped < excess) {
        dropped++;
        if (record.kind === "outcome") outcomes.delete(record.cause);
      } else kept.push(record);
    }
    records = kept;
    return dropped;
  };

  const open = (origin: string): IntentLog => {
    const scope: Scope = { origin, closed: false };
    scopes.add(scope);
    const alive = (what: string) => {
      if (scope.closed) throw new Error(`${origin} is stopped; it cannot ${what}`);
    };
    const log: IntentLog = {
      origin,
      get closed() {
        return scope.closed;
      },
      append(type, payload, opts) {
        alive(`append ${type.id}`);
        if (inProjection > 0) {
          throw new Error(
            `a projection may not append (${origin} tried ${type.id}); use a handler`,
          );
        }
        const policy = policyOf(type);
        const record: IntentRecord<typeof payload> = Object.freeze({
          kind: "intent",
          seq: ++seq,
          type: type.id,
          payload: capture(payload),
          origin,
          ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        });
        if (policy !== "none") pending.set(record.seq, { record });
        enqueue(record);
        return record;
      },
      request(type, payload, opts) {
        return outcome(log.append(type, payload, opts));
      },
      outcome,
      handle(type, fn) {
        alive(`handle ${type.id}`);
        if (policyOf(type) === "none") throw new Error(`${type.id} is an event; it has no handler`);
        const existing = handlers.get(type.id);
        if (existing) {
          throw new Error(
            `${type.id} already has a handler (${existing.scope.origin}); ${origin} is a second`,
          );
        }
        const entry = { scope, fn: fn as (record: IntentRecord) => unknown };
        handlers.set(type.id, entry);
        return () => {
          if (handlers.get(type.id) === entry) handlers.delete(type.id);
        };
      },
      project(fn, opts) {
        alive("project");
        if (opts?.replay) {
          for (const record of records) {
            if (record.seq > dispatchedUpTo) break;
            inProjection++;
            try {
              fn(record);
            } finally {
              inProjection--;
            }
          }
        }
        const entry = { scope, fn };
        projections = [...projections, entry];
        return () => {
          projections = projections.filter((p) => p !== entry);
        };
      },
      since: (after) => records.filter((r) => r.seq > after),
      isPending: (s) => pending.has(s),
      close() {
        if (scope.closed) return;
        scope.closed = true;
        scopes.delete(scope);
        for (const [id, h] of handlers) if (h.scope === scope) handlers.delete(id);
        projections = projections.filter((p) => p.scope !== scope);
        for (const entry of [...pending.values()]) {
          if (entry.scope === scope)
            // "abandoned", not "failed": the effect may already have reached a service
            settle(
              entry,
              false,
              new Error(`abandoned: ${origin} stopped before answering`),
              LOG.origin,
            );
        }
      },
    };
    return log;
  };

  return {
    open,
    records: () => records,
    stats: () => ({
      appended,
      retained: records.length,
      pending: pending.size,
      handlers: handlers.size,
      projections: projections.length,
      openScopes: [...scopes].map((s) => s.origin),
    }),
    compact,
    idle: () =>
      pending.size === 0 ? Promise.resolve() : new Promise<void>((r) => idleWaiters.push(r)),
  };
}

/** The application's log: a kernel service, created on first read (a bundle runs on `{}`). */
export const [getIntentLog, setIntentLog] = defineService<IntentLogCore>("sys:log", (context) =>
  createIntentLog({ logger: getLogger(context).child("log") }),
);

/** Opens the calling bundle's scope on the application's log. The bundle's cleanup closes it. */
export const openLog = (context: Record<string, unknown>, origin: string): IntentLog =>
  getIntentLog(context).open(origin);
