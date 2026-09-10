import type { StorageRegistry } from "./storage-registry.js";

export interface ChangeEvent {
  storageUri: string;
  path: string;
  /** Which job caused it, so a panel can mark the rows it is about to receive. */
  jobId?: string;
  kind: "created" | "removed" | "pending-delete";
}

export type ChangeListener = (batch: ChangeEvent[]) => void;

/** True when `path` is at or below `prefix`. Directory-aware, not string-naive. */
export function isUnder(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/**
 * C4 — freshness comes from OPERATIONS first.
 *
 * There is no `watch()` anywhere in `FilesApi`, so this is not a limitation to
 * design around later: it is the permanent shape. Three tiers, of which only
 * the first ships — operations (authoritative, always available), optional
 * per-storage polling (default OFF, and only for directories someone is
 * actually looking at), and an adapter watcher hook that stays unimplemented.
 *
 * Events are COALESCED into one delivery per tick. `notify()` is synchronous
 * and undifferentiated, so a job completing 500 entries must not pulse 500
 * times — the listener would re-list 500 times for one logical change.
 */
export class ChangeNotifier {
  private readonly _listeners = new Set<ChangeListener>();
  private _pending: ChangeEvent[] = [];
  private _scheduled = false;
  private readonly _polls = new Map<string, ReturnType<typeof setInterval>>();
  private readonly _observed = new Map<string, Set<string>>();

  constructor(private readonly _registry?: StorageRegistry) {}

  onChange(listener: ChangeListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  changed(event: ChangeEvent): void {
    this._pending.push(event);
    if (this._scheduled) return;
    this._scheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** Delivers everything accumulated so far as ONE batch. */
  flush(): void {
    this._scheduled = false;
    if (this._pending.length === 0) return;
    const batch = this._pending;
    this._pending = [];
    for (const listener of this._listeners) listener(batch);
  }

  /**
   * Polling is opt-in per storage and only covers directories with a live
   * observer: a background poll of a remote bucket nobody is looking at is
   * cost with no reader.
   */
  observe(storageUri: string, path: string, onTick: () => void): () => void {
    const paths = this._observed.get(storageUri) ?? new Set<string>();
    paths.add(path);
    this._observed.set(storageUri, paths);

    const pollMs = this._registry?.pollMs(storageUri) ?? 0;
    if (pollMs > 0 && !this._polls.has(storageUri)) {
      this._polls.set(storageUri, setInterval(onTick, pollMs));
    }
    return () => {
      paths.delete(path);
      if (paths.size === 0) this.stopPolling(storageUri);
    };
  }

  observedPaths(storageUri: string): string[] {
    return [...(this._observed.get(storageUri) ?? [])];
  }

  isPolling(storageUri: string): boolean {
    return this._polls.has(storageUri);
  }

  stopPolling(storageUri: string): void {
    const timer = this._polls.get(storageUri);
    if (timer) clearInterval(timer);
    this._polls.delete(storageUri);
  }

  dispose(): void {
    for (const uri of [...this._polls.keys()]) this.stopPolling(uri);
    this._listeners.clear();
  }
}
