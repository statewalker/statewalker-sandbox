import { defineKeyedSlot, type SlotDeclaration } from "@statewalker/shared-slots";
import type { KernelSlots } from "./slots.js";

/**
 * P1: commands are dispatch over handlers published in slots. A command declaration IS a plain
 * slot declaration (its contributions are handlers) plus a policy; answering a command is
 * contributing a handler; calling it is dispatching to the handlers in the slot *at call time*.
 * No call is retained, so a handler only ever receives calls made while it is contributed.
 */

/** `required`: no handler, or none claimed ⇒ the call rejects. `silent`: ⇒ it resolves `undefined`. */
export type CommandPolicy = "required" | "silent";

/** One dispatched call. `resolve` / `reject` are first-wins; later calls no-op. */
export interface Call<P, R> {
  readonly id: number;
  readonly key: string;
  readonly payload: P;
  readonly promise: Promise<R>;
  readonly settled: boolean;
  resolve(value: R): void;
  reject(error: unknown): void;
}

/**
 * Return a promise ⇒ claim (its outcome settles the call); `true` ⇒ claim, settle via `call`
 * yourself; nothing ⇒ observe only. The first claim (in priority order) stops the dispatch.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: an observe-only handler returns nothing
export type HandlerFn<P, R> = (call: Call<P, R>) => Promise<R> | true | void;

/** What a command slot holds. Higher `priority` runs first; equal priorities run in arrival order. */
export interface Handler<P, R> {
  readonly handle: HandlerFn<P, R>;
  readonly priority: number;
}

export interface CommandDeclaration<P, R> extends SlotDeclaration<Handler<P, R>> {
  readonly policy: CommandPolicy;
  readonly label?: string;
}

export function defineCommand<P = void, R = void>(
  key: string,
  options: { policy?: CommandPolicy; label?: string } = {},
): CommandDeclaration<P, R> {
  return Object.freeze({
    ...options,
    key,
    _kind: "plain" as const,
    policy: options.policy ?? "required",
  });
}

export type CommandErrorKind = "no-handlers" | "not-claimed" | "abandoned";

/** Kernel failures only; a handler's own throw or rejection reaches the caller unchanged. */
export class CommandError extends Error {
  constructor(
    readonly kind: CommandErrorKind,
    readonly commandKey: string,
    cause?: unknown,
  ) {
    super(`${kind}: ${commandKey}`, cause === undefined ? undefined : { cause });
    this.name = "CommandError";
  }
}

/** A call in flight, as the kernel records it (`sys:calls`, keyed by call id). */
export interface PendingCall {
  readonly id: number;
  readonly key: string;
  readonly payload: unknown;
}

/** In-flight calls: registered at dispatch, withdrawn when settled. Debugging and dispose read it. */
export const callsSlot = defineKeyedSlot<PendingCall>("sys:calls");

/** Answers `decl` with `fn`: contributes a handler; returns the disposer. */
export function answer<P, R>(
  slots: KernelSlots,
  decl: CommandDeclaration<P, R>,
  fn: HandlerFn<P, R>,
  options: { priority?: number } = {},
): () => void {
  return slots.provide(decl, Object.freeze({ handle: fn, priority: options.priority ?? 0 }));
}

let nextId = 1;

/**
 * Dispatches `payload` to the handlers of `decl` currently in the slot, highest priority first.
 * A handler withdrawn before its turn is skipped. The claiming handler's withdrawal while the call
 * is pending rejects the call (`abandoned`) — an owner that stops never leaves a caller waiting.
 */
export function call<P, R>(
  slots: KernelSlots,
  decl: CommandDeclaration<P, R>,
  payload: P,
): Call<P, R> {
  const id = nextId++;
  let settle!: (ok: boolean, v: unknown) => void;
  const promise = new Promise<R>((res, rej) => {
    settle = (ok, v) => (ok ? res(v as R) : rej(v));
  });
  let settled = false;
  let offPending: (() => void) | undefined;
  let offWatch: (() => void) | undefined;
  const finish = (ok: boolean, v: unknown) => {
    if (settled) return;
    settled = true;
    offWatch?.();
    offPending?.();
    settle(ok, v);
  };
  const c: Call<P, R> = {
    id,
    key: decl.key,
    payload,
    promise,
    get settled() {
      return settled;
    },
    resolve: (value) => finish(true, value),
    reject: (error) => finish(false, error),
  };

  const handlers = [...slots.getSnapshot(decl)].sort((a, b) => b.priority - a.priority);
  let claimer: Handler<P, R> | undefined;
  for (const h of handlers) {
    if (settled) break;
    if (!slots.getSnapshot(decl).includes(h)) continue; // withdrawn during this dispatch
    let out: ReturnType<HandlerFn<P, R>>;
    try {
      out = h.handle(c);
    } catch (error) {
      finish(false, error); // the handler's own failure reaches the caller unwrapped
      break;
    }
    if (out === true || (out && typeof (out as Promise<R>).then === "function")) {
      claimer = h;
      if (out !== true) (out as Promise<R>).then(c.resolve, c.reject);
      break;
    }
  }
  if (!settled && !claimer) {
    if (decl.policy === "silent") finish(true, undefined);
    else finish(false, new CommandError(handlers.length ? "not-claimed" : "no-handlers", decl.key));
  }
  if (!settled && claimer) {
    offPending = slots.register(
      callsSlot,
      String(id),
      Object.freeze({ id, key: decl.key, payload }),
    );
    const h = claimer;
    offWatch = slots.observe(decl, (hs) => {
      if (!hs.includes(h)) c.reject(new CommandError("abandoned", decl.key));
    });
  }
  return c;
}
