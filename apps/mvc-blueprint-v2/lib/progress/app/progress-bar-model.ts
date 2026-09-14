import type { OperationProgress, RunningOperation } from "@sys";
import type { ProgressBar, ProgressBarView } from "./models.js";

/**
 * A progress bar over one running operation — a plain listener set, no
 * reactive library. It knows nothing about what the operation does.
 */
export function createProgressBarModel(source: RunningOperation): {
  view: ProgressBarView;
  dispose(): void;
} {
  let disposed = false;
  const listeners = new Set<() => void>();
  const toBar = (p: OperationProgress): ProgressBar =>
    Object.freeze({ label: p.label, fraction: p.total > 0 ? Math.min(1, p.done / p.total) : 0 });
  let bar = toBar(source.getProgress());
  const notify = () => {
    for (const entry of [...listeners]) {
      if (listeners.has(entry)) entry();
    }
  };
  const offSource = source.onProgressUpdate(() => {
    if (disposed) return;
    const next = toBar(source.getProgress());
    if (next.label === bar.label && next.fraction === bar.fraction) return;
    bar = next;
    notify();
  });
  const view: ProgressBarView = Object.freeze({
    getBar: () => bar,
    onBarUpdate: (listener: () => void) => {
      if (disposed) return () => {};
      const entry = () => {
        try {
          listener();
        } catch (error) {
          console.error(error);
        }
      };
      listeners.add(entry);
      entry();
      return () => {
        listeners.delete(entry);
      };
    },
  });
  return Object.freeze({
    view,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      offSource();
      listeners.clear();
    },
  });
}
