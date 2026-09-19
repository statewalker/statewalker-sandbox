import type { SlotDeclaration } from "@statewalker/shared-slots";
import type { KernelSlots } from "./slots.js";

/**
 * P1: commands are dispatch over handlers published in slots. A command declaration IS a plain
 * slot declaration (its contributions are handlers) plus a policy; answering a command is
 * contributing a handler; calling it is dispatching to the handlers in the slot *at call time*.
 * No call is retained, so a handler only ever receives calls made while it is contributed.
 */

/** `required`: no answerer ⇒ the call rejects. `silent`: ⇒ it resolves `undefined`. */
export type CommandPolicy = "required" | "silent";

/** What a handler sees of one call. */
export interface CallView<P> {
  readonly key: string;
  readonly payload: P;
}

/** One dispatched call. */
export interface Call<R> {
  readonly promise: Promise<R>;
}

/**
 * What a command slot holds: an ANSWER (claims the call; its result or throw settles it) or an
 * OBSERVER (sees every call, before the answer; never claims, whatever it returns).
 */
export type Handler<P, R> =
  | { readonly answer: (call: CallView<P>) => R | Promise<R> }
  | { readonly observe: (call: CallView<P>) => undefined };

export interface CommandDeclaration<P, R> extends SlotDeclaration<Handler<P, R>> {
  readonly policy: CommandPolicy;
  readonly label?: string;
}

/** A `silent` command's result may be `undefined` (no answerer), and is typed so. */
export function defineCommand<P = void, R = void>(
  key: string,
  options?: { policy?: "required"; label?: string },
): CommandDeclaration<P, R>;
export function defineCommand<P = void, R = void>(
  key: string,
  options: { policy: "silent"; label?: string },
): CommandDeclaration<P, R | undefined>;
export function defineCommand<P, R>(
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

export type CommandErrorKind = "no-handlers" | "abandoned";

/** Kernel failures only; an answer's own throw or rejection reaches the caller unchanged. */
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

/**
 * Answers `decl` with `fn`: contributes the handler that CLAIMS every call (sync or async, its
 * result or throw settles the call). The first answer present at call time claims. Returns the
 * disposer.
 */
export function answer<P, R>(
  slots: KernelSlots,
  decl: CommandDeclaration<P, R>,
  fn: (call: CallView<P>) => R | Promise<R>,
): () => void {
  return slots.provide(decl, Object.freeze({ answer: fn }));
}

/** Observes `decl`: `fn` sees every call, before the answer, and can never claim one. */
export function observe<P, R>(
  slots: KernelSlots,
  decl: CommandDeclaration<P, R>,
  fn: (call: CallView<P>) => undefined,
): () => void {
  return slots.provide(decl, Object.freeze({ observe: fn }));
}

/**
 * Dispatches `payload` to the handlers of `decl` present now: every observer (a throwing observer
 * is reported and skipped), then the first answer. The answer's withdrawal while the call is
 * pending rejects the call (`abandoned`) — an owner that stops never leaves a caller waiting.
 */
export function call<P, R>(
  slots: KernelSlots,
  decl: CommandDeclaration<P, R>,
  payload: P,
): Call<R> {
  const view: CallView<P> = Object.freeze({ key: decl.key, payload });
  const handlers = slots.getSnapshot(decl);
  for (const h of handlers) {
    try {
      if ("observe" in h) h.observe(view);
    } catch (error) {
      console.error(`${decl.key}: observer failed`, error);
    }
  }
  const owner = handlers.find((h) => "answer" in h);
  if (!owner || !("answer" in owner)) {
    return decl.policy === "silent"
      ? { promise: Promise.resolve(undefined as R) }
      : { promise: Promise.reject(new CommandError("no-handlers", decl.key)) };
  }
  const promise = new Promise<R>((resolve, reject) => {
    let off = () => {};
    const done = (settle: (v: never) => void) => (v: unknown) => {
      off();
      settle(v as never);
    };
    off = slots.observe(decl, (hs) => {
      if (!hs.includes(owner)) done(reject)(new CommandError("abandoned", decl.key));
    });
    try {
      Promise.resolve(owner.answer(view)).then(done(resolve), done(reject));
    } catch (error) {
      done(reject)(error);
    }
  });
  return { promise };
}
