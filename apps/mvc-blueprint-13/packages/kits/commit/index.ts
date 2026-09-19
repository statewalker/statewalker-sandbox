import type {
  ActionState,
  ActionView,
  CommandDeclaration,
  KernelSlots,
  Listener,
  Logger,
  Scope,
  Unsubscribe,
} from "@p5/kernel";
import { CommandError, call } from "@p5/kernel";
import { newChannels, stableGroup } from "@p5/kit-model";
import { batch, signal, untracked } from "@p5/kit-signals";

/**
 * K §4.3–4.5: action-bound commit records (P3's mechanism C) drained in scopes.
 *
 * A submit that the action accepts produces a record `{ seq, snapshot }`: the kit calls the action's
 * `capture` synchronously inside `submit()`, deep-copies and freezes the result, and appends it. The
 * view stays payload-free (`submit()`); the record is the commit.
 *
 * Writers (single-writer rule, one per field):
 * - `records` — the INTENT SOURCE (the view, or a command on its behalf), through `submit()`,
 *   which returns whether a record was accepted;
 * - `settled` — the CONTROLLER, through the drain (`settle(seq)`);
 * - `label` / `icon` / `hint` / base `enabled` — the controller, through `update`.
 * `running` is derived: "a record is not settled yet". It is not writable, so a controller cannot
 * forget to set it, and it flips inside `submit()` — a second submit in the same tick is refused by
 * the action itself.
 */

export interface CommitRecord<T> {
  /** Order within this action (settle cursor). Order across actions is the drain's arrival order. */
  readonly seq: number;
  /** What the commit means, captured at submit; deep-frozen. */
  readonly snapshot: T;
}

export interface CommitControl<T> {
  /** Records accepted and not yet settled, oldest first. */
  getRecords(): readonly CommitRecord<T>[];
  onRecordsUpdate(listener: Listener): Unsubscribe;
  /** Marks every record up to and including `seq` handled. The drain calls it; authors never do. */
  settle(seq: number): void;
  /** Describes the action. `running` is derived from the records and cannot be written. */
  update(patch: Partial<Omit<ActionState, "running">>): void;
  /** Claims the records for ONE drain; a second claim throws (`drainCommits` calls it). */
  claim(): void;
}

export interface CommitActionOptions<T> {
  readonly label: string;
  readonly icon?: string;
  readonly hint?: string;
  /** Base flag, default `true`. */
  readonly enabled?: boolean;
  /** Reactive guard over the owning model's (or a kit `track`'s) reads, derived synchronously. */
  readonly when?: () => boolean;
  /** Queue (event edge): accept submits while records are unsettled. Default: refuse. */
  readonly queue?: boolean;
  /**
   * What the commit means, read at submit time: synchronous, pure, structured-cloneable (no
   * functions, no class instances). A capture that throws refuses the submit and is logged.
   */
  readonly capture: () => T;
}

export interface CommitActionModel<T> {
  readonly view: ActionView;
  readonly control: CommitControl<T>;
  dispose(): void;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const NONE: readonly never[] = Object.freeze([]);

export function createCommitAction<T>(options: CommitActionOptions<T>): CommitActionModel<T> {
  let disposed = false;
  let claimed = false;
  let lastSeq = 0;
  const channels = newChannels(() => disposed);
  const label = signal(options.label);
  const icon = signal<string | undefined>(options.icon);
  const hint = signal<string | undefined>(options.hint);
  const enabled = signal(options.enabled ?? true);
  const log = signal<readonly CommitRecord<T>[]>(NONE);
  const settled = signal(0);
  const when = options.when ?? (() => true);

  const records = stableGroup((): readonly CommitRecord<T>[] => {
    const all = log();
    const through = settled();
    return Object.freeze(all.filter((r) => r.seq > through));
  });
  const state = stableGroup((): ActionState => {
    const l = label();
    const i = icon();
    const h = hint();
    const e = enabled();
    const w = when();
    const r = records().length > 0;
    return Object.freeze({ label: l, icon: i, hint: h, enabled: e && w, running: r });
  });

  const view: ActionView = Object.freeze({
    getState: () => state(),
    onStateUpdate: channels.channel(state),
    submit: () => {
      if (disposed) return false;
      const current = untracked(() => state());
      if (!current.enabled || (current.running && !options.queue)) return false;
      let snapshot: T;
      try {
        snapshot = deepFreeze(structuredClone(untracked(options.capture)));
      } catch (error) {
        console.error(`"${current.label}": capture failed, submit refused`, error);
        return false;
      }
      const pending = untracked(() => records());
      log(Object.freeze([...pending, Object.freeze({ seq: ++lastSeq, snapshot })]));
      return true;
    },
  });

  const control: CommitControl<T> = Object.freeze({
    getRecords: () => records(),
    onRecordsUpdate: channels.channel(records),
    settle: (seq: number) => {
      if (!disposed && seq > untracked(() => settled())) settled(seq);
    },
    update: (patch: Partial<Omit<ActionState, "running">>) => {
      if (disposed) return;
      batch(() => {
        if (patch.label !== undefined) label(patch.label);
        if (patch.icon !== undefined) icon(patch.icon);
        if (patch.hint !== undefined) hint(patch.hint);
        if (patch.enabled !== undefined) enabled(patch.enabled);
      });
    },
    claim: () => {
      if (claimed) throw new Error(`"${options.label}" is already drained: one drain per action`);
      claimed = true;
    },
  });

  return Object.freeze({
    view,
    control,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      channels.dispose();
    },
  });
}

/** What a handler gets besides the snapshot. */
export interface Turn {
  /**
   * Awaits `work` while the drain's owner is open; afterwards the continuation is dropped. Work
   * given as a function is not even started once the owner closed.
   */
  task<R>(work: Promise<R> | (() => Promise<R>)): Promise<R>;
  /** `call` through the owner: never dispatched once it closed, never settles after. */
  call<P, R>(decl: CommandDeclaration<P, R>, payload: P): Promise<R>;
  /** Aborted when the record's session closes: hand it to cancellable reads. */
  readonly signal: AbortSignal;
}

/** One commit source for `drainCommits`: an action's records and what handling one means. */
export interface CommitHandler {
  readonly control: CommitControl<unknown>;
  readonly handle: (snapshot: unknown, turn: Turn) => unknown;
}

export function on<T>(
  control: CommitControl<T>,
  handle: (snapshot: T, turn: Turn) => unknown,
): CommitHandler {
  return { control: control as CommitControl<unknown>, handle: handle as CommitHandler["handle"] };
}

/** Who a drain belongs to. */
export interface DrainOwner {
  /** The bundle scope: the drain, and every record it accepted, lives until it closes. */
  readonly scope: Scope;
  /** The session the records come from (default `scope`): its close ends intake, not handling. */
  readonly session?: Scope;
  readonly slots: KernelSlots;
  readonly log: Pick<Logger, "error">;
}

/**
 * A controller's commit consumer — ONE LANE. Handles the records of its actions one at a time, in
 * the order they were accepted, a microtask after the submit, and settles each record when its
 * handler finishes — resolved or thrown. Independent streams get independent drains (Add vs the
 * selection actions); a session-closing intent (Cancel) gets its own, so it never waits behind a
 * running Save — whose outcome the rule below still reports.
 *
 * The outcome rule (K §4.5, D4): a record accepted while `session` was open is handled even if the
 * session closes before or while it runs; writes to the session's disposed models are ignored and
 * the bundle's notifications remain. When `scope` (the bundle) closes, the drain and every
 * continuation awaited through the turn are dropped: nothing is written after deactivation.
 *
 * Each action is drained by one drain only (a second claim throws). A handler's throw is logged.
 */
export function drainCommits(owner: DrainOwner, ...handlers: CommitHandler[]): void {
  const { scope: home, session = home, slots, log } = owner;
  for (const h of handlers) h.control.claim();
  let scheduled = false;
  let running = false;
  let arrival = 0;
  const seen = new WeakMap<CommitRecord<unknown>, number>();
  const cursor = new Map<CommitHandler, number>();
  const live = () => !home.closed;
  const turn: Turn = {
    task: (work) => home.task(work),
    call: (decl, payload) => home.task(() => call(slots, decl, payload).promise),
    signal: session.signal,
  };
  const stamp = () => {
    for (const h of handlers)
      for (const r of h.control.getRecords()) if (!seen.has(r)) seen.set(r, ++arrival);
  };
  const next = (): [CommitHandler, CommitRecord<unknown>] | undefined => {
    stamp();
    let best: [CommitHandler, CommitRecord<unknown>] | undefined;
    for (const h of handlers) {
      const after = cursor.get(h) ?? 0;
      const r = h.control.getRecords().find((x) => x.seq > after);
      if (r && (!best || (seen.get(r) ?? 0) < (seen.get(best[1]) ?? 0))) best = [h, r];
    }
    return best;
  };

  const run = async () => {
    scheduled = false;
    if (running) return;
    running = true;
    try {
      for (let item = next(); item && live(); item = next()) {
        const [h, record] = item;
        cursor.set(h, record.seq);
        try {
          await home.task(Promise.resolve().then(() => h.handle(record.snapshot, turn)));
        } catch (error) {
          log.error("commit handler failed", { error: String(error) });
        } finally {
          h.control.settle(record.seq);
        }
      }
    } finally {
      running = false;
    }
  };
  const kick = () => {
    stamp();
    if (!live() || scheduled) return;
    scheduled = true;
    queueMicrotask(() => void run());
  };
  // Subscriptions end with the session (no new records can arrive from its disposed models);
  // records already accepted are still handled, in the bundle scope.
  for (const h of handlers) session.defer(h.control.onRecordsUpdate(kick));
}

/**
 * The stream helper: consumes `stream` while `scope` is open, calling `fn` per item; when the
 * scope closes the pending read is dropped and the iterator is returned (a streaming controller's
 * `for await`, which R11 forbids).
 */
export async function each<T>(
  scope: Scope,
  stream: AsyncIterable<T>,
  fn: (item: T) => void,
): Promise<void> {
  const it = stream[Symbol.asyncIterator]();
  scope.defer(() => void it.return?.());
  for (let r = await scope.task(it.next()); !r.done; r = await scope.task(it.next())) fn(r.value);
}

/**
 * A session: a child scope of `scope`, built at once by `build`; the promise resolves when it
 * closes. A handler that returns `task(session(…))` keeps its action `running` while the dialog
 * is open.
 */
export function session(scope: Scope, build: (session: Scope) => void): Promise<void> {
  return new Promise((closed) => {
    const s = scope.child();
    s.defer(closed);
    build(s);
  });
}

/** A readable reason. An `abandoned` call (its owner left) reads as "not completed" (D7). */
export function describeError(error: unknown): string {
  if (error instanceof CommandError && error.kind === "abandoned") return "not completed";
  return error instanceof Error ? error.message : String(error);
}

export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly error: unknown };

/** Runs one piece of work; never rejects. A failure is logged at warn (it is owner state, not a crash). */
export async function attempt<T>(
  log: Pick<Logger, "warn">,
  what: string,
  work: () => Promise<T>,
): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const message = describeError(error);
    log.warn(`${what} failed`, { error: message });
    return { ok: false, message, error };
  }
}
