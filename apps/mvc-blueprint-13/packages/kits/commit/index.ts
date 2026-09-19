import type { ActionState, ActionView, Listener, Logger, Scope, Unsubscribe } from "@p5/kernel";
import { CommandError } from "@p5/kernel";
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
 * - `records` — the VIEW, through `submit()` (append only);
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
  /** What the commit means, read at submit time. Must not write. */
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
      if (disposed) return;
      const current = untracked(() => state());
      if (!current.enabled || (current.running && !options.queue)) return;
      const snapshot = deepFreeze(structuredClone(untracked(options.capture)));
      const pending = untracked(() => records());
      log(Object.freeze([...pending, Object.freeze({ seq: ++lastSeq, snapshot })]));
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
  /** Awaits `work` while the drain lives (see `drainCommits`); afterwards the continuation is dropped. */
  task<R>(work: Promise<R>): Promise<R>;
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

/** The scope a drain survives in: the scope itself, or — for a session — its bundle scope. */
function outermost(scope: Scope): Scope {
  let s = scope;
  while (!s.isBundle && s.parent) s = s.parent;
  return s;
}

/**
 * A controller's commit consumer. Handles the records of its actions ONE AT A TIME, in the order
 * they were accepted (commit order across actions), a microtask after the submit, and settles each
 * record when its handler finishes — resolved or thrown.
 *
 * Scopes (K §4.5, the outcome rule "the narrowest open scope takes the outcome"):
 * - a record accepted while `scope` was open is handled even if `scope` (a session) closes before
 *   or while it runs: the drain then continues in the bundle scope. The handler's writes to the
 *   session's models are ignored (they are disposed with it) and the bundle's notifications
 *   remain — so a late outcome is reported, never silently dropped;
 * - when the bundle scope closes, the drain and every continuation awaited through `turn.task`
 *   are dropped: nothing is written after deactivation. Unhandled records stay unsettled on
 *   models that are disposed with the bundle.
 *
 * A handler's throw is logged at `error` (a handler should turn failures into owner state first).
 */
export function drainCommits(
  scope: Scope,
  log: Pick<Logger, "error">,
  ...handlers: CommitHandler[]
): void {
  const home = outermost(scope);
  let scheduled = false;
  let running = false;
  let arrival = 0;
  const seen = new WeakMap<CommitRecord<unknown>, number>();
  const cursor = new Map<CommitHandler, number>();
  const live = () => !home.closed;
  const turn: Turn = { task: (work) => home.task(work) };

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
  for (const h of handlers) scope.defer(h.control.onRecordsUpdate(kick));
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
