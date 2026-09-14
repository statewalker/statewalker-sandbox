import { type Command, type CommandDeclaration, Commands } from "@statewalker/shared-commands";
import type { Logger } from "@statewalker/shared-logger";
import { type KeyedSlotDeclaration, type SlotDeclaration, Slots } from "@statewalker/shared-slots";

/**
 * The inspector's source, applied only by the composition root. Every trace is
 * logged at `trace` level on a `{ module: "trace" }` child of the CURRENT app
 * logger — resolved per call, because the logs controller replaces the logger
 * after these objects exist.
 */
type LoggerSource = () => Logger;

const CHANNEL = /^on[A-Z]\w*Update$/;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const kindOf = (value: unknown): string | undefined => {
  const kind = (value as { kind?: { id?: unknown } } | null)?.kind;
  return typeof kind?.id === "string" ? kind.id : undefined;
};

/**
 * A frozen copy of a model facet. Every function is bound to the original, so
 * closure facets and class-backed facets both work; each `on…Update` listener
 * is wrapped to log one `model:notify` per delivery. Not a Proxy: facets are
 * frozen, and a Proxy must return a frozen object's own functions.
 */
export function traceModel<M>(model: M, meta: Record<string, unknown>, logger: LoggerSource): M {
  if (model === null || typeof model !== "object") return model;
  const source = model as Record<string, unknown>;
  const traced: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const member = source[key];
    if (typeof member !== "function") {
      traced[key] = member;
      continue;
    }
    const bound = (member as (...args: unknown[]) => unknown).bind(source);
    traced[key] = CHANNEL.test(key)
      ? (listener: () => void) =>
          bound(() => {
            logger()
              .child({ module: "trace" })
              .trace("model:notify", { ...meta, channel: key });
            listener();
          })
      : bound;
  }
  return Object.freeze(traced) as M;
}

export function traceContribution<T>(value: T, slot: string, logger: LoggerSource): T {
  if (value === null || typeof value !== "object" || !("model" in value)) return value;
  const contribution = value as T & { model: unknown };
  return Object.freeze({
    ...contribution,
    model: traceModel(contribution.model, { slot, kind: kindOf(value) }, logger),
  });
}

export class TracingCommands extends Commands {
  constructor(private readonly _logger: LoggerSource) {
    super();
  }

  override call<P, R>(decl: CommandDeclaration<P, R>, payload: P): Command<P, R> {
    const log = this._logger().child({ module: "trace" });
    const startedAt = performance.now();
    const ms = () => Math.round(performance.now() - startedAt);
    log.trace("command:call", { key: decl.key });
    const cmd = super.call(decl, payload);
    // Attaching a rejection handler marks the promise handled: under tracing, a
    // caller that ignores a rejection no longer triggers an unhandled-rejection warning.
    cmd.promise.then(
      () => log.trace("command:settled", { key: decl.key, ok: true, ms: ms() }),
      (error: unknown) =>
        log.trace("command:settled", { key: decl.key, ok: false, ms: ms(), error: message(error) }),
    );
    return cmd;
  }
}

/**
 * Logs every contribution and its withdrawal, and traces the models handed to
 * the UI. Caveat: re-registering the SAME value under a keyed id throws
 * `RangeError` here (it would refcount untraced), because each registration
 * passes a fresh traced copy.
 */
export class TracingSlots extends Slots {
  constructor(private readonly _logger: LoggerSource) {
    super();
  }

  override provide<T>(decl: SlotDeclaration<T>, value: T): () => void {
    const meta = { slot: decl.key, kind: kindOf(value) };
    const traced = decl.key.startsWith("ui:")
      ? traceContribution(value, decl.key, this._logger)
      : value;
    this._log().trace("slot:provide", meta);
    return this._once(super.provide(decl, traced), meta);
  }

  override register<T>(decl: KeyedSlotDeclaration<T>, id: string, value: T): () => void {
    const meta = { slot: decl.key, id, kind: kindOf(value) };
    const traced = decl.key.startsWith("ui:")
      ? traceContribution(value, decl.key, this._logger)
      : value;
    this._log().trace("slot:provide", meta);
    return this._once(super.register(decl, id, traced), meta);
  }

  private _log(): Logger {
    return this._logger().child({ module: "trace" });
  }

  private _once(off: () => void, meta: Record<string, unknown>): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this._log().trace("slot:dispose", meta);
      off();
    };
  }
}
