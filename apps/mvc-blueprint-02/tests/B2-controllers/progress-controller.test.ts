import { type ProgressBarView, ProgressController } from "@progress/app";
import {
  type OperationProgress,
  progressSlot,
  type RunningOperation,
  runningOperationsSlot,
} from "@sys";
import { describe, expect, it } from "vitest";
import { newTestContext } from "../support/context.js";

function fakeOperation(label = "work", total = 4) {
  let progress: OperationProgress = { label, done: 0, total };
  const listeners = new Set<() => void>();
  const operation: RunningOperation = {
    getProgress: () => progress,
    onProgressUpdate: (l) => {
      listeners.add(l);
      l();
      return () => listeners.delete(l);
    },
  };
  return {
    operation,
    set(done: number) {
      progress = { ...progress, done };
      for (const l of [...listeners]) l();
    },
  };
}

describe("B2 · progress controller", () => {
  it("projects each running operation into a progress bar, live, and withdraws it when the operation ends", async () => {
    const { ctx, slots } = newTestContext();
    const progress = new ProgressController();
    progress.activate(ctx);
    const op = fakeOperation("Adding 4 sample todos", 4);
    const off = slots.provide(runningOperationsSlot, op.operation);
    const bars = slots.getSnapshot(progressSlot);
    expect(bars).toHaveLength(1);
    expect(bars[0].kind.id).toBe("progress:bar");
    const bar = bars[0].model as ProgressBarView;
    expect(bar.getBar()).toEqual({ label: "Adding 4 sample todos", fraction: 0 });
    op.set(1);
    expect(bar.getBar().fraction).toBe(0.25);
    off();
    expect(slots.getSnapshot(progressSlot)).toHaveLength(0);
    await progress.dispose();
  });

  it("picks up operations that were running before it activated, and dispose withdraws every bar", async () => {
    const { ctx, slots } = newTestContext();
    slots.provide(runningOperationsSlot, fakeOperation("a").operation);
    slots.provide(runningOperationsSlot, fakeOperation("b").operation);
    const progress = new ProgressController();
    progress.activate(ctx);
    expect(slots.getSnapshot(progressSlot)).toHaveLength(2);
    await progress.dispose();
    expect(slots.getSnapshot(progressSlot)).toHaveLength(0);
  });
});
