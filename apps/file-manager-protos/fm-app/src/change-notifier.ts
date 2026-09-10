export type ChangeKind = "created" | "removed" | "updated";

/**
 * One change, from whatever produced it.
 *
 * Every invalidation carries `storage` + `path`, and the originating `jobId`
 * from day one. Nothing consumes the job id in v1 beyond per-row marking — it
 * costs a field, and without it the optimistic-rows version later needs the
 * engine changed rather than just the panel.
 *
 * A move emits `removed(from)` and `created(to)` rather than a pair: the two
 * ends are re-paired through the job id, which is the only identifier that
 * survives a producer that coalesces by path.
 */
export interface Invalidation {
  storage: string;
  path: string;
  kind: ChangeKind;
  jobId?: string;
}

/**
 * Anything that wants to hear about a directory. `storage` and `path` are read
 * live on every fan-out, because a panel that navigates is observing a
 * different directory from the one it registered with.
 */
export interface ChangeObserver {
  readonly storage: string;
  readonly path: string;
  /** Called at most ONCE per batch, with only the changes that matched. */
  applyChanges(changes: Invalidation[]): void;
}

export interface ChangeNotifierOptions {
  /**
   * Poll interval per storage, in milliseconds. Absent means **off**, which is
   * the default for every storage: `list()` on a remote is a real cost, and
   * "F2 refreshes" is an accepted commander idiom.
   */
  pollMs?: Record<string, number>;
}

/**
 * Does `cwd` cover `path`? The naive `path.startsWith(cwd)` is wrong — it makes
 * `/dst-old/a.txt` a change inside `/dst` — so the separator is part of the
 * test, and an exact match counts.
 */
export function covers(cwd: string, path: string): boolean {
  if (path === cwd) return true;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix);
}

/**
 * C4 — change notification, tier one.
 *
 * A layer above the files APIs reporting what changed, so a copy into a
 * directory another panel is showing updates that panel. **No adapter exposes a
 * watcher** — there is no `watch()` anywhere in `webrun-files` — so changes come
 * from operations this app performed, or from polling. That is the permanent
 * shape, not a limitation to design around later.
 *
 * This is a producer-agnostic entry point rather than something the job engine
 * calls directly, which is what keeps a later BroadcastChannel stage contained
 * to one file: a producer that publishes outgoing invalidations and republishes
 * incoming ones into this same path.
 */
export class ChangeNotifier {
  private readonly _observers = new Set<ChangeObserver>();
  private readonly _timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly _holders = new Map<string, number>();
  private _queue: Invalidation[] = [];
  private _flush?: Promise<void>;

  constructor(private readonly _options: ChangeNotifierOptions = {}) {}

  /**
   * Registers an observer and returns its release.
   *
   * The poll timer is pinned SYNCHRONOUSLY here, before any await: bookkeeping is
   * not I/O and must not inherit its latency. Releasing is idempotent and an
   * unknown release is a no-op — without that rule one holder's double release
   * stops a poll another holder still depends on.
   */
  observe(observer: ChangeObserver): () => void {
    this._observers.add(observer);
    this._retain(observer.storage);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._observers.delete(observer);
      this._release(observer.storage);
    };
  }

  /**
   * Queues one change. Delivery is coalesced onto a microtask, so a job
   * completing 500 entries produces one fan-out rather than 500: `notify()` is
   * synchronous and undifferentiated, and 500 of them is 500 re-renders.
   */
  invalidate(change: Invalidation): void {
    this._queue.push(change);
    this._schedule();
  }

  invalidateAll(changes: Invalidation[]): void {
    for (const change of changes) this.invalidate(change);
  }

  /** Resolves once every queued batch has been delivered. */
  async settled(): Promise<void> {
    while (this._flush) await this._flush;
  }

  /** The storages currently being polled. */
  polling(): string[] {
    return [...this._timers.keys()];
  }

  dispose(): void {
    for (const timer of this._timers.values()) clearInterval(timer);
    this._timers.clear();
    this._holders.clear();
    this._observers.clear();
    this._queue = [];
  }

  private _schedule(): void {
    if (this._flush) return;
    this._flush = Promise.resolve().then(() => {
      const batch = this._queue;
      this._queue = [];
      try {
        this._deliver(batch);
      } finally {
        this._flush = undefined;
        // An observer may invalidate while it is being notified — that is exactly
        // the republishing shape a later cross-tab producer needs. Its change
        // arrived while `_flush` was still set, so nothing scheduled it: without
        // this line it waits for an unrelated invalidation and may never land.
        if (this._queue.length > 0) this._schedule();
      }
    });
  }

  /** The prefix fan-out: the same ten lines of logic, iterating over observers. */
  private _deliver(batch: Invalidation[]): void {
    if (batch.length === 0) return;
    for (const observer of this._observers) {
      const mine = batch.filter(
        (change) => change.storage === observer.storage && covers(observer.path, change.path),
      );
      if (mine.length > 0) observer.applyChanges(mine);
    }
  }

  private _retain(storage: string): void {
    this._holders.set(storage, (this._holders.get(storage) ?? 0) + 1);
    const ms = this._options.pollMs?.[storage];
    if (!ms || this._timers.has(storage)) return;
    const timer = setInterval(() => this._poll(storage), ms);
    // A poll must never be the reason a process stays alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    this._timers.set(storage, timer);
  }

  private _release(storage: string): void {
    const remaining = (this._holders.get(storage) ?? 0) - 1;
    if (remaining > 0) {
      this._holders.set(storage, remaining);
      return;
    }
    this._holders.delete(storage);
    const timer = this._timers.get(storage);
    if (timer === undefined) return;
    clearInterval(timer);
    this._timers.delete(storage);
  }

  /** Only directories with a live observer are polled. */
  private _poll(storage: string): void {
    for (const observer of this._observers) {
      if (observer.storage !== storage) continue;
      this.invalidate({ storage, path: observer.path, kind: "updated" });
    }
  }
}
