/**
 * The actor system: an address space, mailboxes, one scheduler, and the stream hub.
 *
 * Nothing else is shared between bundles. A bundle is an actor spawned at its address; it holds its
 * state in its own closure, receives messages one at a time, and reaches the outside world only
 * through its `ActorContext`: send / ask messages, publish / subscribe streams, watch addresses.
 *
 * Scheduling (same thread, no workers):
 *  - Every delivery goes through ONE FIFO run queue. A send from outside any actor (a test, a view)
 *    drains the queue before it returns, so a click is fully processed — stream updates included —
 *    before the event handler returns. A send from inside a handler is queued and runs after the
 *    current handler returns (run-to-completion, never re-entrant).
 *  - Handlers are synchronous. Async work re-enters the actor as a mailbox turn: `ctx.pipe(promise,
 *    cb)`, `ctx.after(ms, cb)`, and stream / presence callbacks all run as turns of the owning actor,
 *    and are dropped once it has stopped. "Nothing is written after a late await" is structural.
 *
 * Stop: the actor's queued messages are rejected (asks reject with `ActorStopped`, tells become dead
 * letters), asks it received but has not answered reject, its streams are released, its timers and
 * subscriptions cancelled, and every later message to the address is a dead letter.
 */
import { type Logger, type LogSink, newLogger } from "./logger.js";
import { type Listener, StreamHub, type StreamKey, type StreamReader } from "./streams.js";

/** An address carries the type of the messages it accepts. Declared in API modules. */
export type Address<M> = string & { readonly __msg?: M };
export const defineAddress = <M>(id: string): Address<M> => id as Address<M>;

/** A request message declares its reply type by extending `Asks<R>`. */
export interface Asks<R> {
  readonly __reply?: R;
}
// biome-ignore lint/suspicious/noConfusingVoidType: a request with no answer resolves to void
export type ReplyOf<K> = K extends Asks<infer R> ? R : void;
/** The reply of the member of `N` whose `type` is `T`. */
export type ReplyTo<N, T> = ReplyOf<Extract<N, { readonly type: T }>>;

export class NoSuchActor extends Error {
  constructor(readonly address: string) {
    super(`no actor at "${address}"`);
    this.name = "NoSuchActor";
  }
}
export class ActorStopped extends Error {
  constructor(readonly address: string) {
    super(`actor "${address}" stopped before answering`);
    this.name = "ActorStopped";
  }
}

/** What a handler learns about the message beyond its body. */
export interface Envelope {
  readonly from?: string;
  /** True when the sender awaits an answer (`ask`). */
  readonly expectsReply: boolean;
  ok(value?: unknown): void;
  fail(error: unknown): void;
}

export type Receive<M> = (msg: M, env: Envelope) => void;
export type Behavior<M> = (ctx: ActorContext<M>) => Receive<M>;

export interface ActorContext<M> {
  readonly self: Address<M>;
  readonly log: Logger;
  isAlive(): boolean;
  send<N>(to: Address<N>, msg: N): void;
  ask<N extends { readonly type: string }, T extends N["type"]>(
    to: Address<N>,
    msg: N & { readonly type: T },
  ): Promise<ReplyTo<N, T>>;
  /** Run `ok`/`err` as a turn of this actor when the promise settles — dropped after stop. */
  pipe<T>(promise: Promise<T>, ok: (value: T) => void, err?: (error: unknown) => void): void;
  /** Run `cb` as a turn of this actor after `ms` — cancelled on stop. Returns a canceller. */
  after(ms: number, cb: () => void): () => void;
  /** Publish a stream this actor owns (the first publish claims it). */
  publish<S>(key: StreamKey<S>, value: S): void;
  /** Read a stream's current value. */
  read<S>(key: StreamKey<S>): S | undefined;
  /** Receive a stream's values as turns of this actor: the current one first, then every change. */
  subscribe<S>(key: StreamKey<S>, cb: (value: S | undefined) => void): () => void;
  /** Learn, as turns, whether an address is alive: now, then on every spawn/stop there. */
  watch(address: string, cb: (alive: boolean) => void): () => void;
  onStop(cb: () => void): void;
  /** The UI edge: a port that lets a host render streams and forward view messages. */
  viewPort(): ViewPort;
}

export interface ViewPort extends StreamReader {
  send(to: string, msg: unknown): void;
}

interface Reply {
  settled: boolean;
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

type Job =
  | { kind: "msg"; to: string; msg: unknown; from?: string; reply?: Reply }
  | { kind: "turn"; to: string; run: () => void };

interface Actor {
  readonly address: string;
  receive?: Receive<unknown>;
  alive: boolean;
  readonly cleanups: (() => void)[];
  readonly pending: Set<Reply>;
  delivered: number;
}

export interface DeadLetter {
  readonly to: string;
  readonly from?: string;
  readonly msg: unknown;
}

export interface CloneFailure {
  readonly kind: "message" | "stream";
  readonly where: string;
  readonly error: string;
}

export interface SystemOptions {
  readonly logSink?: LogSink;
  /** Structured-clone every message and stream value, recording what could not cross a worker boundary. */
  readonly cloneCheck?: boolean;
}

export class ActorSystem {
  readonly log: Logger;
  readonly streams: StreamHub;
  readonly deadLetters: DeadLetter[] = [];
  readonly cloneFailures: CloneFailure[] = [];
  readonly #actors = new Map<string, Actor>();
  readonly #watchers = new Map<string, Set<{ watcher: Actor; cb: (alive: boolean) => void }>>();
  readonly #queue: Job[] = [];
  readonly #cloneCheck: boolean;
  #draining = false;
  #delivered = 0;
  #turns = 0;

  constructor(options: SystemOptions = {}) {
    this.log = newLogger("sys", options.logSink);
    this.#cloneCheck = options.cloneCheck ?? false;
    this.streams = new StreamHub((key, error) =>
      this.log.error(`a subscriber of "${key}" threw`, error),
    );
  }

  /** Addresses of live actors, in spawn order. */
  addresses(): string[] {
    return [...this.#actors.keys()];
  }

  isAlive(address: string): boolean {
    return this.#actors.get(address)?.alive === true;
  }

  /** Messages delivered (per live actor), and turns run (stream, presence, pipe and timer callbacks). */
  stats(): { delivered: number; turns: number; perActor: Record<string, number> } {
    const perActor: Record<string, number> = {};
    for (const a of this.#actors.values()) perActor[a.address] = a.delivered;
    return { delivered: this.#delivered, turns: this.#turns, perActor };
  }

  spawn<M>(address: Address<M> | string, behavior: Behavior<M>): void {
    if (this.#actors.get(address)?.alive) throw new Error(`"${address}" is already taken`);
    const actor: Actor = {
      address,
      alive: true,
      cleanups: [],
      pending: new Set(),
      delivered: 0,
    };
    this.#actors.set(address, actor);
    const ctx = this.#context<M>(actor);
    let failed: { error: unknown } | undefined;
    this.#enqueue({
      kind: "turn",
      to: address,
      run: () => {
        try {
          actor.receive = behavior(ctx) as Receive<unknown>;
        } catch (error) {
          failed = { error };
        }
      },
    });
    this.#announce(address, true);
    this.#drain();
    // Setup ran synchronously unless spawn was called from inside a handler. A failed setup stops
    // the actor; a caller outside any handler (the loader) gets the error to roll back on.
    if (failed) {
      this.log.error(`setup of "${address}" failed`, failed.error);
      this.stop(address);
      if (!this.#draining) throw failed.error;
    }
  }

  stop(address: string): void {
    const actor = this.#actors.get(address);
    if (!actor?.alive) return;
    actor.alive = false;
    this.#actors.delete(address);
    // The mailbox: asks reject, tells become dead letters.
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const job = this.#queue[i] as Job;
      if (job.to !== address) continue;
      this.#queue.splice(i, 1);
      if (job.kind === "msg") this.#undeliverable(job, new ActorStopped(address));
    }
    for (const reply of actor.pending) this.#settle(reply, false, new ActorStopped(address));
    actor.pending.clear();
    for (const cleanup of actor.cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        this.log.error(`cleanup of "${address}" threw`, error);
      }
    }
    for (const [, set] of this.#watchers) {
      for (const w of [...set]) if (w.watcher === actor) set.delete(w);
    }
    this.#announce(address, false);
    this.#drain();
  }

  send<N>(to: Address<N> | string, msg: N, from?: string): void {
    this.#check("message", `${from ?? "outside"} → ${to}`, msg);
    this.#enqueue({ kind: "msg", to, msg, from });
    this.#drain();
  }

  /** Untyped on purpose: outside callers (tests, loaders) are not actors; `ctx.ask` is the typed one. */
  ask<R = unknown>(to: string, msg: unknown, from?: string): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.#check("message", `${from ?? "outside"} → ${to}`, msg);
      const reply: Reply = {
        settled: false,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      this.#enqueue({ kind: "msg", to, msg, from, reply });
      this.#drain();
    });
  }

  /** A port for code outside any actor — a test, a host — that reads streams and sends. */
  port(from = "outside"): ViewPort {
    return {
      get: (key) => this.streams.get(key),
      subscribe: (key, l: Listener) => this.streams.subscribe(key, l),
      send: (to, msg) => this.send(to, msg, from),
    };
  }

  // ---------------------------------------------------------------------------------------------

  #context<M>(actor: Actor): ActorContext<M> {
    const self = actor.address as Address<M>;
    const log = this.log.child(actor.address);
    const alive = () => actor.alive;
    const turn = (run: () => void) => {
      if (!actor.alive) return;
      this.#enqueue({ kind: "turn", to: actor.address, run });
      this.#drain();
    };
    const ctx: ActorContext<M> = {
      self,
      log,
      isAlive: alive,
      send: (to, msg) => {
        if (alive()) this.send(to, msg, actor.address);
      },
      ask: <N extends { readonly type: string }, T extends N["type"]>(
        to: Address<N>,
        msg: N & { readonly type: T },
      ) =>
        alive()
          ? this.ask<ReplyTo<N, T>>(to, msg, actor.address)
          : Promise.reject(new ActorStopped(self)),
      pipe: (promise, ok, err) => {
        promise.then(
          (v) => turn(() => ok(v)),
          (e) => turn(() => (err ? err(e) : log.error("an unhandled failure reached an actor", e))),
        );
      },
      after: (ms, cb) => {
        if (!alive()) return () => {};
        const id = setTimeout(() => turn(cb), ms);
        const cancel = () => clearTimeout(id);
        actor.cleanups.push(cancel);
        return cancel;
      },
      publish: (key, value) => {
        if (!alive()) return;
        this.#check("stream", key, value);
        if (this.streams.ownerOf(key) !== actor.address) {
          actor.cleanups.push(() => this.streams.release(key, actor.address));
        }
        this.streams.publish(key, actor.address, value);
      },
      read: (key) => this.streams.get(key),
      subscribe: (key, cb) => {
        if (!alive()) return () => {};
        // Every callback — the immediate one too — is a turn, so a subscriber never runs inside
        // another actor's publish. The value is captured at publish time: turns keep publish order.
        const unsubscribe = this.streams.subscribe(key, () => {
          const value = this.streams.get(key);
          turn(() => cb(value));
        });
        actor.cleanups.push(unsubscribe);
        return unsubscribe;
      },
      watch: (address, cb) => {
        if (!alive()) return () => {};
        let set = this.#watchers.get(address);
        if (!set) {
          set = new Set();
          this.#watchers.set(address, set);
        }
        const entry = { watcher: actor, cb };
        set.add(entry);
        const now = this.isAlive(address);
        turn(() => cb(now));
        const unwatch = () => set.delete(entry);
        actor.cleanups.push(unwatch);
        return unwatch;
      },
      onStop: (cb) => {
        actor.cleanups.push(cb);
      },
      viewPort: () => ({
        get: (key) => this.streams.get(key),
        subscribe: (key, l) => this.streams.subscribe(key, l),
        send: (to, msg) => {
          if (alive()) this.send(to, msg, actor.address);
        },
      }),
    };
    return ctx;
  }

  #announce(address: string, up: boolean): void {
    for (const w of this.#watchers.get(address) ?? []) {
      if (!w.watcher.alive) continue;
      this.#enqueue({ kind: "turn", to: w.watcher.address, run: () => w.cb(up) });
    }
  }

  #enqueue(job: Job): void {
    this.#queue.push(job);
  }

  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      let job = this.#queue.shift();
      while (job) {
        this.#run(job);
        job = this.#queue.shift();
      }
    } finally {
      this.#draining = false;
    }
  }

  #run(job: Job): void {
    const actor = this.#actors.get(job.to);
    if (!actor?.alive) {
      if (job.kind === "msg") this.#undeliverable(job, new NoSuchActor(job.to));
      return;
    }
    if (job.kind === "turn") {
      this.#turns++;
      try {
        job.run();
      } catch (error) {
        this.log.error(`a turn of "${actor.address}" threw`, error);
      }
      return;
    }
    actor.delivered++;
    this.#delivered++;
    const reply = job.reply;
    if (reply) actor.pending.add(reply);
    const env: Envelope = {
      from: job.from,
      expectsReply: reply !== undefined,
      ok: (value) => {
        if (reply && !reply.settled) {
          actor.pending.delete(reply);
          this.#check("message", `${actor.address} ⇒ reply`, value);
          this.#settle(reply, true, value);
        }
      },
      fail: (error) => {
        if (reply && !reply.settled) {
          actor.pending.delete(reply);
          this.#settle(reply, false, error);
        }
      },
    };
    try {
      if (!actor.receive) throw new Error(`"${actor.address}" received a message before setup`);
      actor.receive(job.msg, env);
    } catch (error) {
      this.log.error(`"${actor.address}" failed on a message`, error);
      env.fail(error);
    }
  }

  #undeliverable(job: Extract<Job, { kind: "msg" }>, error: Error): void {
    if (job.reply) {
      this.#settle(job.reply, false, error);
      return;
    }
    this.deadLetters.push({ to: job.to, from: job.from, msg: job.msg });
    this.log.info(`dead letter to "${job.to}"`, job.msg);
  }

  #settle(reply: Reply, ok: boolean, value: unknown): void {
    if (reply.settled) return;
    reply.settled = true;
    if (ok) reply.resolve(value);
    else reply.reject(value);
  }

  #check(kind: CloneFailure["kind"], where: string, value: unknown): void {
    if (!this.#cloneCheck) return;
    try {
      structuredClone(value);
    } catch (error) {
      this.cloneFailures.push({ kind, where, error: String(error) });
    }
  }
}
