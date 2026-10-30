import type { PeerShareModel, PeerShareSnapshot } from "../public/extension-points.js";

/** One snapshot per change, so `useSyncExternalStore` sees a stable value between changes. */
export class Model implements PeerShareModel {
  private snapshot: PeerShareSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly read: () => PeerShareSnapshot) {
    this.snapshot = read();
  }

  getSnapshot = (): PeerShareSnapshot => this.snapshot;

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  };

  /** Called by the managers after every change. */
  changed = (): void => {
    this.snapshot = this.read();
    for (const listener of [...this.listeners]) listener();
  };
}
