import type { Logger } from "@kernel";
import { type Attempt, attempt } from "@kit/loop";
import {
  FsmProcess,
  type FsmState,
  type FsmStateConfig,
  isStateTransitionEnabled,
} from "@statewalker/fsm";

export type { FsmStateConfig as Chart } from "@statewalker/fsm";

/** What a state's `enter` receives: the event (and its data) that entered it, and its own reach. */
export interface StateScope {
  readonly event: string;
  readonly data: unknown;
  /** Sends an event to the machine — dropped if this state has exited before it is processed. */
  send(event: string, data?: unknown): void;
  /**
   * Runs async work owned by this state. `then` runs only if the state is still active when the
   * work settles — so it may write models without any "still active?" check — and returns the
   * event to send (or nothing). The work's signal aborts when the state exits.
   */
  task<T>(
    work: (signal: AbortSignal) => Promise<T>,
    then: (result: Attempt<T>) => string | undefined,
  ): void;
}

/** A state's exit, or its exit plus handlers for its children (they close over the parent's locals). */
// biome-ignore lint/suspicious/noConfusingVoidType: a handler that returns nothing is the common case
export type Entered = void | (() => void) | { exit?: () => void; states?: Handlers };
export type Handlers = Readonly<Record<string, (scope: StateScope) => Entered>>;

export interface Machine {
  /** Queues an event. It is checked against the chart when it is PROCESSED: an event no state
   * handles at that moment is dropped (refused), never a reason to leave a state. */
  send(event: string, data?: unknown): void;
  /** The active state keys, root → leaf. */
  states(): readonly string[];
  /** Resolves once every queued event has been processed. */
  idle(): Promise<void>;
  /** Stops: pending events dropped, every active state exits (inner first); later sends are no-ops. */
  stop(): Promise<void>;
}

/**
 * A controller's internal state as a hierarchical machine (`@statewalker/fsm`'s engine). Handlers
 * run in a microtask after `send`, never inside the caller's notification; events are processed
 * one at a time, in order.
 */
export function startMachine(
  chart: FsmStateConfig,
  handlers: Handlers,
  options: { log: Logger; name: string },
): Machine {
  const process = new FsmProcess(chart);
  const children = new WeakMap<FsmState, Handlers>();
  /** [event, data, the sender's liveness — a state's sends die with it]. */
  const queue: [string, unknown, (() => boolean)?][] = [["", undefined]];
  let data: unknown;
  let stopped = false;
  let pumping: Promise<void> | undefined;

  const fail = (error: unknown) =>
    options.log.error(`${options.name}: state handler threw`, { error: String(error) });
  // The engine's default sink is console.error; route it to the logger.
  (process as unknown as { _handleError: (e: unknown) => void })._handleError = fail;

  process.onStateCreate((state) => {
    state.onEnter(() => {
      let exited = false;
      let owner = state.parent;
      while (owner && !children.has(owner)) owner = owner.parent;
      const handler = (owner ? children.get(owner) : handlers)?.[state.key];
      if (!handler) return;
      const scope: StateScope = {
        event: process.event ?? "",
        data,
        send: (event, d) => send(event, d, () => !exited),
        task: (work, then) => {
          const abort = new AbortController();
          state.onExit(() => abort.abort());
          void attempt(options.log, `${options.name}: ${state.key}`, () => work(abort.signal)).then(
            (result) => {
              if (exited || stopped) return;
              try {
                const event = then(result);
                if (event) send(event, undefined, () => !exited);
              } catch (error) {
                fail(error);
              }
            },
          );
        },
      };
      const entered = handler(scope);
      if (typeof entered === "function") state.onExit(entered);
      else if (entered) {
        if (entered.exit) state.onExit(entered.exit);
        if (entered.states) children.set(state, entered.states);
      }
      // Registered last, so it runs first on exit (the engine unwinds exits in reverse).
      state.onExit(() => {
        exited = true;
      });
    });
  });

  async function pump(): Promise<void> {
    while (queue.length > 0 && !stopped) {
      const [event, d, alive] = queue.shift() as (typeof queue)[number];
      if (alive && !alive()) continue;
      if (event !== "" && !isStateTransitionEnabled(process, event)) continue;
      data = d;
      await process.dispatch(event);
    }
    pumping = undefined;
  }
  function send(event: string, d?: unknown, alive?: () => boolean): void {
    if (stopped) return;
    queue.push([event, d, alive]);
    pumping ??= Promise.resolve().then(pump);
  }
  pumping = Promise.resolve().then(pump);

  return {
    send: (event, d) => send(event, d),
    states() {
      const keys: string[] = [];
      for (let s = process.state; s; s = s.parent) keys.unshift(s.key);
      return keys;
    },
    async idle() {
      while (pumping) await pumping;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      queue.length = 0;
      await pumping;
      await process.shutdown();
    },
  };
}
