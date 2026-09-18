import type { ActionState, ActionView, Listener, Unsubscribe } from "@kernel";
import { newChannels, stableGroup } from "@kit/model";
import { batch, signal, untracked } from "@kit/signals";

/**
 * Mechanism C — action-bound commit records (P3).
 *
 * A submit that the action accepts produces a record `{ seq, snapshot }`: the kit calls the
 * action's `capture` synchronously inside `submit()`, deep-copies and freezes the result, and
 * appends it. The view stays payload-free (`submit()`); the record is the commit.
 *
 * Writers (single-writer rule, one per field):
 * - `records` — the VIEW, through `submit()` (append only; it also compacts what is settled);
 * - `settled` — the CONTROLLER, through `settle(seq)`;
 * - `label` / `icon` / `hint` / base `enabled` — the controller, through `update`.
 * `running` is derived: "a record is not settled yet". It is not writable, so a controller cannot
 * forget to set it, and it flips inside `submit()` — a second submit in the same tick is refused by
 * the action itself (the P0 same-tick hole cannot exist).
 */

export interface CommitRecord<T> {
  /** Realm-wide order: records of different actions compare by `seq`. */
  readonly seq: number;
  /** What the commit means, captured at submit; deep-frozen. */
  readonly snapshot: T;
}

export interface CommitControl<T> {
  /** Records accepted and not yet settled, oldest first. */
  getRecords(): readonly CommitRecord<T>[];
  onRecordsUpdate(listener: Listener): Unsubscribe;
  /** Marks every record up to and including `seq` handled. */
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
  /** Reactive guard, derived synchronously (as `createAction`'s). */
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

let lastSeq = 0;

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

/** One commit source for `drainCommits`: an action's records and what handling one means. */
export interface CommitHandler {
  readonly control: CommitControl<unknown>;
  readonly handle: (record: CommitRecord<unknown>) => Promise<void> | void;
}

export function on<T>(
  control: CommitControl<T>,
  handle: (snapshot: T, record: CommitRecord<T>) => Promise<void> | void,
): CommitHandler {
  return {
    control: control as CommitControl<unknown>,
    handle: (record) => handle(record.snapshot as T, record as CommitRecord<T>),
  };
}

/**
 * A controller's commit consumer: handles the records of several actions ONE AT A TIME, in `seq`
 * order (commit order across actions), a microtask after the submit, and settles each record when
 * its handler finishes — whether it resolved, threw, or the drain was stopped meanwhile. Stopping
 * leaves unhandled records unsettled (the owner disposes their models with it).
 */
export function drainCommits(
  options: { isActive(): boolean; onError(error: unknown): void },
  ...handlers: CommitHandler[]
): () => void {
  let stopped = false;
  let scheduled = false;
  let running = false;
  const cursor = new Map<CommitHandler, number>();
  const live = () => !stopped && options.isActive();

  const next = (): [CommitHandler, CommitRecord<unknown>] | undefined => {
    let best: [CommitHandler, CommitRecord<unknown>] | undefined;
    for (const h of handlers) {
      const after = cursor.get(h) ?? 0;
      const r = h.control.getRecords().find((x) => x.seq > after);
      if (r && (!best || r.seq < best[1].seq)) best = [h, r];
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
          await h.handle(record);
        } catch (error) {
          if (live()) options.onError(error);
        } finally {
          h.control.settle(record.seq);
        }
      }
    } finally {
      running = false;
    }
  };
  const kick = () => {
    if (!live() || scheduled) return;
    scheduled = true;
    queueMicrotask(() => void run());
  };
  const offs = handlers.map((h) => h.control.onRecordsUpdate(kick));
  return () => {
    if (stopped) return;
    stopped = true;
    for (const off of offs) off();
  };
}
