import { signal, untracked } from "@signals";
import type { RunningOperation } from "@sys";
import { newChannels, stableGroup } from "./signal-model.js";

export interface SampleOperation {
  readonly operation: RunningOperation;
  advance(): void;
  dispose(): void;
}

/** The running-operation model the todo controller contributes to `ops:running`. */
export function createSampleOperation(label: string, total: number): SampleOperation {
  const done = signal(0);
  const ch = newChannels();
  const progress = stableGroup(() => ({ label, done: done(), total }));
  const operation: RunningOperation = Object.freeze({
    getProgress: () => progress(),
    onProgressUpdate: ch.channel(progress),
  });
  return Object.freeze({
    operation,
    advance: () => {
      if (!ch.disposed) done(Math.min(total, untracked(() => done()) + 1));
    },
    dispose: () => ch.dispose(),
  });
}
